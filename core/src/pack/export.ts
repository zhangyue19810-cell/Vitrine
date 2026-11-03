import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModrinthClient, ModrinthVersion } from "../content/modrinth";
import { throwIfAborted } from "../util/async";
import { dirSize, fileSize } from "../util/fsx";
import { writeZip, type ZipSource } from "../util/zip";
import { MRPACK_INDEX } from "./mrpack";
import type { PackLoader } from "./types";

/** Top-level names that are never exported: launcher bookkeeping, caches and logs. */
const NEVER = new Set(["natives", ".vitrine", "logs", "crash-reports", "webcache", "webcache2", ".mixin.out", "vitrine.json", "vitrine-pack.json", "usercache.json", "usernamecache.json", "launcher_profiles.json", "realms_persistence.json", "hs_err_pid"]);
const NEVER_SUFFIX = [".vtmp", ".vseg", ".lock"];

/** Folders that belong in a pack and are ticked by default. */
const DEFAULT_ON = new Set(["mods", "config", "defaultconfigs", "kubejs", "scripts", "resourcepacks", "shaderpacks", "datapacks", "global_packs", "openloader", "fancymenu_data", "patchouli_books", "paxi", "packmenu", "emotes", "journeymap-config"]);

export interface ExportCandidate {
  /** Path relative to the game directory. */
  path: string;
  kind: "dir" | "file";
  size: number;
  defaultInclude: boolean;
  /** Why a person might not want to include it. */
  note?: string;
}

function internalName(name: string, instanceId: string): boolean {
  const lower = name.toLowerCase();
  if (NEVER.has(lower) || lower.startsWith("hs_err_pid")) return true;
  if (lower === `${instanceId.toLowerCase()}.json` || lower === `${instanceId.toLowerCase()}.jar`) return true;
  return NEVER_SUFFIX.some((suffix) => lower.endsWith(suffix));
}

/** The top-level entries of a game directory a person can choose to export, with sizes and sensible defaults. */
export async function listExportCandidates(gameDir: string, instanceId: string): Promise<ExportCandidate[]> {
  const out: ExportCandidate[] = [];
  const entries = await readdir(gameDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || internalName(entry.name, instanceId)) continue;
    const full = join(gameDir, entry.name);
    const lower = entry.name.toLowerCase();
    let note: string | undefined;
    if (lower === "saves") note = "存档通常很大，而且包含个人进度";
    else if (lower === "screenshots") note = "个人截图";
    else if (lower === "options.txt") note = "包含你个人的按键和画面设置";
    else if (lower === "servers.dat") note = "包含你的服务器列表";
    if (entry.isDirectory()) out.push({ path: entry.name, kind: "dir", size: await dirSize(full), defaultInclude: DEFAULT_ON.has(lower), note });
    else if (entry.isFile()) out.push({ path: entry.name, kind: "file", size: (await stat(full)).size, defaultInclude: false, note });
  }
  return out.sort((a, b) => Number(b.defaultInclude) - Number(a.defaultInclude) || a.path.localeCompare(b.path));
}

interface LocalFile {
  rel: string;
  abs: string;
  size: number;
}

async function walk(root: string, rel: string, instanceId: string, out: LocalFile[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (!rel && internalName(entry.name, instanceId)) continue;
    if (NEVER_SUFFIX.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) continue;
    if (entry.isDirectory()) await walk(root, next, instanceId, out, signal);
    else if (entry.isFile()) out.push({ rel: next, abs: join(root, next), size: (await fileSize(join(root, next))) ?? 0 });
  }
}

function hashBoth(path: string): Promise<{ sha1: string; sha512: string }> {
  return new Promise((resolve, reject) => {
    const sha1 = createHash("sha1");
    const sha512 = createHash("sha512");
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => {
      sha1.update(chunk);
      sha512.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha1: sha1.digest("hex"), sha512: sha512.digest("hex") }));
  });
}

const LOADER_KEY: Record<PackLoader["kind"], string> = { fabric: "fabric-loader", quilt: "quilt-loader", forge: "forge", neoforge: "neoforge" };
const IDENTIFIABLE = /^(mods|resourcepacks|shaderpacks)\/[^/]+\.(jar|zip)$/i;

export interface ExportOptions {
  gameDir: string;
  instanceId: string;
  dest: string;
  name: string;
  version: string;
  summary?: string;
  mcVersion: string;
  loader?: PackLoader;
  /** Top-level paths (folders or files) to include. */
  include: string[];
  /** Look mods up on Modrinth so they are listed as downloads instead of bundled. Default true. */
  identify?: boolean;
  signal?: AbortSignal;
  onProgress?: (info: { stage: "scan" | "hash" | "lookup" | "write"; done: number; total: number }) => void;
}

export interface ExportResult {
  dest: string;
  /** Files listed in the index (downloaded by the importing launcher). */
  listed: number;
  /** Files copied into the archive. */
  bundled: number;
  /** Mods / packs that could not be matched to Modrinth and were bundled as they are. */
  bundledContent: string[];
  size: number;
  warnings: string[];
}

type EnvValue = "required" | "optional" | "unsupported";
const toEnv = (value: string | undefined): EnvValue => (value === "optional" || value === "unsupported" ? value : "required");

/**
 * Write a Modrinth `.mrpack`. Mods, resource packs and shader packs that Modrinth recognises by hash become
 * download entries; everything else is copied into `overrides/`.
 */
export async function exportMrpack(deps: { modrinth: ModrinthClient }, options: ExportOptions): Promise<ExportResult> {
  const warnings: string[] = [];
  const { signal, onProgress } = options;

  onProgress?.({ stage: "scan", done: 0, total: options.include.length });
  const files: LocalFile[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of options.include.entries()) {
    const path = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!path || path.split("/").includes("..") || internalName(path.split("/")[0], options.instanceId)) {
      warnings.push(`已忽略不能导出的项目：${raw}`);
      continue;
    }
    const abs = join(options.gameDir, path);
    const info = await stat(abs).catch(() => undefined);
    if (!info) continue;
    const found: LocalFile[] = [];
    if (info.isDirectory()) await walk(options.gameDir, path, options.instanceId, found, signal);
    else if (info.isFile()) found.push({ rel: path, abs, size: info.size });
    for (const file of found) {
      if (seen.has(file.rel)) continue;
      seen.add(file.rel);
      files.push(file);
    }
    onProgress?.({ stage: "scan", done: index + 1, total: options.include.length });
  }
  if (!files.length) throw new Error("没有选中任何可导出的文件");

  const candidates = files.filter((file) => IDENTIFIABLE.test(file.rel));
  const hashes = new Map<string, { sha1: string; sha512: string }>();
  if (options.identify !== false && candidates.length) {
    let done = 0;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (cursor < candidates.length) {
          throwIfAborted(signal);
          const file = candidates[cursor++];
          hashes.set(file.rel, await hashBoth(file.abs));
          onProgress?.({ stage: "hash", done: ++done, total: candidates.length });
        }
      }),
    );
  }

  const matches = new Map<string, ModrinthVersion>();
  if (hashes.size) {
    onProgress?.({ stage: "lookup", done: 0, total: 1 });
    try {
      const found = await deps.modrinth.versionsByHashes([...new Set([...hashes.values()].map((entry) => entry.sha1))], "sha1", signal);
      for (const [rel, hash] of hashes) {
        const version = found[hash.sha1];
        if (version) matches.set(rel, version);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      warnings.push(`无法连接 Modrinth 识别模组（${(error as Error).message}），所有文件都会直接打包进压缩包`);
    }
    onProgress?.({ stage: "lookup", done: 1, total: 1 });
  }

  const envByProject = new Map<string, { client: EnvValue; server: EnvValue }>();
  if (matches.size) {
    try {
      const ids = [...new Set([...matches.values()].map((version) => version.project_id))];
      for (let i = 0; i < ids.length; i += 100) {
        for (const project of await deps.modrinth.projects(ids.slice(i, i + 100), signal)) {
          envByProject.set(project.id, { client: toEnv(project.client_side), server: toEnv(project.server_side) });
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      warnings.push("无法读取模组的客户端/服务端适用范围，已按“都需要”处理");
    }
  }

  const listed: Record<string, unknown>[] = [];
  const sources: ZipSource[] = [];
  const bundledContent: string[] = [];
  for (const file of files) {
    const version = matches.get(file.rel);
    const hash = hashes.get(file.rel);
    const remote = version?.files.find((entry) => entry.hashes.sha1?.toLowerCase() === hash?.sha1);
    if (version && hash && remote) {
      listed.push({
        path: file.rel,
        hashes: { sha1: hash.sha1, sha512: remote.hashes.sha512 ?? hash.sha512 },
        env: envByProject.get(version.project_id) ?? { client: "required", server: "required" },
        downloads: [remote.url],
        fileSize: file.size,
      });
    } else {
      sources.push({ name: `overrides/${file.rel}`, file: file.abs, compress: !/\.(jar|zip|png|ogg|mca|nbt|dat)$/i.test(file.rel) });
      if (IDENTIFIABLE.test(file.rel) && options.identify !== false) bundledContent.push(file.rel);
    }
  }
  if (bundledContent.length) warnings.push(`有 ${bundledContent.length} 个模组/资源包在 Modrinth 上找不到，已直接打包。公开发布前请确认它们允许再分发。`);

  const dependencies: Record<string, string> = { minecraft: options.mcVersion };
  if (options.loader) dependencies[LOADER_KEY[options.loader.kind]] = options.loader.version;
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: options.version,
    name: options.name,
    ...(options.summary ? { summary: options.summary } : {}),
    files: listed,
    dependencies,
  };
  await writeZip(options.dest, [{ name: MRPACK_INDEX, data: JSON.stringify(index, null, 2) }, ...sources], {
    signal,
    onEntry: (done, total) => onProgress?.({ stage: "write", done, total }),
  });
  return { dest: options.dest, listed: listed.length, bundled: sources.length, bundledContent, size: (await fileSize(options.dest)) ?? 0, warnings };
}
