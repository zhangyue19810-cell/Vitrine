import { createWriteStream } from "node:fs";
import { chmod, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import yauzl from "yauzl";
import yazl from "yazl";
import { throwIfAborted } from "./async";
import { ensureDir, safeJoin } from "./fsx";

/**
 * Zip helpers shared by native extraction, installers and modpack import/export.
 *
 * Reading goes through yauzl with raw file names so that archives written by Chinese Windows tools
 * (GBK names without the UTF-8 flag) still decode correctly; writing goes through yazl (always UTF-8).
 */

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
  mtime: Date;
  /** Unix mode from the external attributes, when the archive was written on a Unix-like system. */
  mode?: number;
  raw: yauzl.Entry;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function decodeZipName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString("utf8");
  try {
    return utf8.decode(raw);
  } catch {
    /* not UTF-8 */
  }
  try {
    return new TextDecoder("gbk").decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

export class ZipReader {
  readonly entries: ZipEntry[] = [];
  private readonly byName = new Map<string, ZipEntry>();
  private closed = false;
  private constructor(private readonly zip: yauzl.ZipFile) {}

  static open(path: string): Promise<ZipReader> {
    return ZipReader.load((callback) => yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: false }, callback));
  }

  /** Read an archive that is already in memory (nested jars inside a mod). */
  static fromBuffer(buffer: Buffer): Promise<ZipReader> {
    return ZipReader.load((callback) => yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, callback));
  }

  private static load(start: (callback: (error: Error | null, zip?: yauzl.ZipFile) => void) => void): Promise<ZipReader> {
    return new Promise((resolve, reject) => {
      start((error, zip) => {
        if (error || !zip) return reject(error ?? new Error("Cannot open zip"));
        const reader = new ZipReader(zip);
        zip.on("error", reject);
        zip.on("entry", (entry: yauzl.Entry) => {
          const name = decodeZipName(entry.fileName as unknown as Buffer, entry.generalPurposeBitFlag).replace(/\\/g, "/");
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const madeByUnix = (entry.versionMadeBy >> 8) === 3;
          const item: ZipEntry = {
            name,
            size: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            isDirectory: name.endsWith("/"),
            mtime: entry.getLastModDate(),
            mode: madeByUnix && unixMode ? unixMode & 0o7777 : undefined,
            raw: entry,
          };
          reader.entries.push(item);
          if (!reader.byName.has(name)) reader.byName.set(name, item);
          zip.readEntry();
        });
        zip.once("end", () => resolve(reader));
        zip.readEntry();
      });
    });
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  find(predicate: (entry: ZipEntry) => boolean): ZipEntry | undefined {
    return this.entries.find(predicate);
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  stream(entry: ZipEntry | string): Promise<Readable> {
    const target = typeof entry === "string" ? this.byName.get(entry) : entry;
    if (!target) return Promise.reject(new Error(`Entry not found in zip: ${String(entry)}`));
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(target.raw, (error, stream) => (error || !stream ? reject(error ?? new Error("Cannot read entry")) : resolve(stream)));
    });
  }

  async read(entry: ZipEntry | string, maxBytes = 512 * 1024 * 1024): Promise<Buffer> {
    const stream = await this.stream(entry);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        stream.destroy();
        throw new Error("Zip entry is larger than the allowed limit");
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async readText(entry: ZipEntry | string): Promise<string> {
    return (await this.read(entry)).toString("utf8").replace(/^﻿/, "");
  }

  async readJson<T = unknown>(entry: ZipEntry | string): Promise<T> {
    return JSON.parse(await this.readText(entry)) as T;
  }

  /**
   * Extract entries below `dest`. `map` returns the relative target path for an entry, or undefined to skip it.
   * Every target is passed through safeJoin, so a malicious archive cannot write outside `dest`.
   */
  async extractTo(
    dest: string,
    options: {
      map?: (entry: ZipEntry) => string | undefined;
      signal?: AbortSignal;
      onFile?: (entry: ZipEntry, target: string) => void;
      concurrency?: number;
    } = {},
  ): Promise<number> {
    const jobs: { entry: ZipEntry; target: string }[] = [];
    for (const entry of this.entries) {
      if (entry.isDirectory) continue;
      const relative = options.map ? options.map(entry) : entry.name;
      if (!relative) continue;
      jobs.push({ entry, target: safeJoin(dest, relative) });
    }
    let index = 0;
    let done = 0;
    const worker = async () => {
      while (true) {
        throwIfAborted(options.signal);
        const job = jobs[index++];
        if (!job) return;
        await ensureDir(dirname(job.target));
        const source = await this.stream(job.entry);
        await pipeline(source, createWriteStream(job.target));
        if (job.entry.mode && job.entry.mode & 0o111) await chmod(job.target, job.entry.mode & 0o777).catch(() => {});
        await utimes(job.target, job.entry.mtime, job.entry.mtime).catch(() => {});
        done++;
        options.onFile?.(job.entry, job.target);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 6, jobs.length)) }, worker));
    return done;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.zip.close();
    } catch {
      /* already closed */
    }
  }
}

export async function withZip<T>(path: string, fn: (zip: ZipReader) => Promise<T>): Promise<T> {
  const zip = await ZipReader.open(path);
  try {
    return await fn(zip);
  } finally {
    zip.close();
  }
}

export async function readZipEntry(path: string, name: string): Promise<Buffer | undefined> {
  return withZip(path, async (zip) => (zip.has(name) ? zip.read(name) : undefined));
}

export async function zipHasEntry(path: string, name: string): Promise<boolean> {
  try {
    return await withZip(path, async (zip) => zip.has(name));
  } catch {
    return false;
  }
}

export interface ZipSource {
  /** Path inside the archive. */
  name: string;
  /** Either a file on disk or in-memory content. */
  file?: string;
  data?: Buffer | string;
  mode?: number;
  compress?: boolean;
}

/** Create a zip archive from files and buffers. Streams file content, so large packs do not sit in memory. */
export async function writeZip(
  dest: string,
  sources: ZipSource[],
  options: { signal?: AbortSignal; onEntry?: (index: number, total: number, name: string) => void; level?: number } = {},
): Promise<void> {
  await ensureDir(dirname(dest));
  const zip = new yazl.ZipFile();
  const output = createWriteStream(dest);
  const finished = pipeline(zip.outputStream, output);
  try {
    let index = 0;
    for (const source of sources) {
      throwIfAborted(options.signal);
      const name = source.name.replace(/\\/g, "/").replace(/^\/+/, "");
      const compress = source.compress ?? true;
      if (source.file) {
        const info = await stat(source.file);
        zip.addFile(source.file, name, { mtime: info.mtime, mode: source.mode ?? info.mode, compress, compressionLevel: options.level } as unknown as yazl.Options);
      } else {
        const data = typeof source.data === "string" ? Buffer.from(source.data, "utf8") : (source.data ?? Buffer.alloc(0));
        zip.addBuffer(data, name, { mtime: new Date(), mode: source.mode ?? 0o100644, compress, compressionLevel: options.level } as unknown as yazl.Options);
      }
      options.onEntry?.(++index, sources.length, name);
    }
  } catch (error) {
    (zip.outputStream as unknown as Readable).destroy();
    output.destroy();
    await finished.catch(() => {});
    throw error;
  }
  zip.end();
  await finished;
}
