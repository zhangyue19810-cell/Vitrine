import { createHash, type BinaryLike } from "node:crypto";
import { createReadStream, constants as fsc } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export type HashAlgorithm = "sha1" | "sha256" | "sha512" | "md5";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch {
    return fallback;
  }
}

/** Write via a temporary sibling and rename so a crash never leaves a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, data);
  await replaceFile(tmp, path);
}

export async function writeJsonAtomic(path: string, value: unknown, pretty = true): Promise<void> {
  await writeFileAtomic(path, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

/** rename() that also works on Windows when the destination exists. */
export async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST" || code === "EACCES") {
      await unlink(to).catch(() => {});
      await rename(from, to);
    } else throw error;
  }
}

export function hashFile(path: string, algorithm: HashAlgorithm = "sha1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function hashBuffer(data: BinaryLike, algorithm: HashAlgorithm = "sha1"): string {
  return createHash(algorithm).update(data).digest("hex");
}

export async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

export async function removeRecursive(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function copyFileEnsured(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  await copyFile(from, to);
}

export async function copyDir(from: string, to: string, filter?: (relative: string) => boolean): Promise<number> {
  let count = 0;
  const walk = async (rel: string) => {
    const entries = await readdir(join(from, rel), { withFileTypes: true });
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (filter && !filter(next)) continue;
      if (entry.isDirectory()) {
        await ensureDir(join(to, next));
        await walk(next);
      } else if (entry.isFile()) {
        await copyFileEnsured(join(from, next), join(to, next));
        count++;
      }
    }
  };
  await ensureDir(to);
  await walk("");
  return count;
}

/** Total size of a directory tree in bytes (symlinks are not followed). */
export async function dirSize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) total += await dirSize(full);
      else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }),
  );
  return total;
}

export async function setExecutable(path: string): Promise<void> {
  if (process.platform !== "win32") await chmod(path, 0o755).catch(() => {});
}

/** Read the first `length` bytes of a file (used for sniffing zip/gzip signatures). */
export async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve `relative` below `root`, refusing absolute paths and `..` escapes.
 * Archive entries and manifest paths are untrusted input.
 */
export function safeJoin(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe path: ${relative}`);
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error(`Unsafe path: ${relative}`);
  return join(root, ...parts);
}
