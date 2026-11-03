import { copyFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CurseForgeClient } from "../content/curseforge";
import type { InstallHooks } from "../loaders/forge-installer";
import { installInstance, type InstallDeps, type LoaderChoice } from "../loaders/install";
import { listForge, listNeoForge, type LoaderVersion, type MetaDeps } from "../loaders/meta";
import { uniqueName, validateInstanceName, type ModpackOrigin } from "../mc/instances";
import { versionDir } from "../mc/version-json";
import type { DownloadItem, FileEvent, HashSpec } from "../net/download";
import { isAbort } from "../util/async";
import { ensureDir, exists, hashFile, readJson, removeRecursive, safeJoin, writeJsonAtomic } from "../util/fsx";
import { resolveCurseForgeFiles, type UnresolvedFile } from "./cf-pack";
import { openPack } from "./detect";
import { checkPackPath } from "./guard";
import { PackError, type PackFile, type PackFormat, type PackLoader, type PackManifest, type PackSettings } from "./types";

export interface PackDeps {
  install: InstallDeps;
  curseforge: CurseForgeClient;
  /** Parallel downloads for a pack's files; undefined falls back to the engine setting. */
  concurrency?: () => number | undefined;
}

export interface PackHooks extends InstallHooks {
  warning?: (message: string) => void;
  /** Fired for every pack file that finished, was already present, or failed. */
  file?: (event: FileEvent) => void;
}

export interface PackInstallRequest {
  file: string;
  /** Instance folder name; defaults to the pack's name. */
  name?: string;
  signal?: AbortSignal;
  hooks?: PackHooks;
  /** Leave out optional files: true for all of them, or a list of paths. */
  skipOptional?: boolean | string[];
  /** Extra origin data (project / version ids from an online install). */
  origin?: Partial<ModpackOrigin>;
  concurrency?: number;
  /** Extra download hosts to trust for .mrpack files. */
  allowHosts?: string[];
}

export interface PackFailure {
  path: string;
  label?: string;
  error: string;
  pageUrl?: string;
  /** Needs a manual download from the author's page. */
  restricted?: boolean;
}

export interface PackInstallResult {
  id: string;
  name: string;
  mcVersion: string;
  loader?: LoaderChoice;
  totalFiles: number;
  downloaded: number;
  skipped: number;
  overrideFiles: number;
  failed: PackFailure[];
  unresolved: UnresolvedFile[];
  /** False when some required file is still missing: the instance exists and can be repaired. */
  complete: boolean;
  warnings: string[];
}

export interface PackPreview {
  format: PackFormat;
  name: string;
  version?: string;
  author?: string;
  summary?: string;
  mcVersion: string;
  loader?: PackLoader;
  fileCount: number;
  overrideCount: number;
  optionalFiles: { path: string; label?: string }[];
  warnings: string[];
  settings?: PackSettings;
}

const STATE_FILE = "vitrine-pack.json";

interface StoredFile {
  path: string;
  urls: string[];
  size?: number;
  hashes?: HashSpec;
  label?: string;
  pageUrl?: string;
  restricted?: boolean;
  optional?: boolean;
}

export interface PackState {
  version: 1;
  origin: ModpackOrigin;
  mcVersion: string;
  files: StoredFile[];
  failed: PackFailure[];
  unresolved: UnresolvedFile[];
  complete: boolean;
  updatedAt: number;
}

export function packStatePath(root: string, id: string): string {
  return join(versionDir(root, id), STATE_FILE);
}

export async function readPackState(root: string, id: string): Promise<PackState | undefined> {
  try {
    const state = await readJson<PackState>(packStatePath(root, id));
    return state?.version === 1 && Array.isArray(state.files) ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Read an archive and describe it without installing anything. */
export async function previewPack(file: string, options: { allowHosts?: string[] } = {}): Promise<PackPreview> {
  const pack = await openPack(file, options);
  try {
    const { manifest } = pack;
    const prefixes = manifest.overrides.map((prefix) => prefix.toLowerCase());
    const overrideCount = pack.zip.entries.filter((entry) => !entry.isDirectory && prefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix))).length;
    return {
      format: manifest.format,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      summary: manifest.summary,
      mcVersion: manifest.mcVersion,
      loader: manifest.loader,
      fileCount: manifest.files.length,
      overrideCount,
      optionalFiles: manifest.files.filter((entry) => entry.optional && entry.path).map((entry) => ({ path: entry.path, label: entry.label })),
      warnings: manifest.warnings,
      settings: manifest.settings,
    };
  } finally {
    pack.close();
  }
}

/** Map a pack's loader statement to an installable choice (looking up the maven version string). */
export async function resolveLoaderChoice(meta: MetaDeps, mcVersion: string, loader: PackLoader): Promise<LoaderChoice> {
  if (loader.kind === "fabric" || loader.kind === "quilt") return { kind: loader.kind, version: loader.version };
  // Some packs state the full maven version ("1.20.1-47.2.20"); the listing uses the short one.
  const wanted = loader.version.startsWith(`${mcVersion}-`) ? loader.version.slice(mcVersion.length + 1) : loader.version;
  let entries: LoaderVersion[] = [];
  try {
    entries = loader.kind === "forge" ? await listForge(meta, mcVersion) : await listNeoForge(meta, mcVersion);
  } catch (error) {
    if (isAbort(error)) throw error;
    meta.log?.warn(`could not list ${loader.kind} versions: ${(error as Error).message}`);
  }
  const hit = entries.find((entry) => entry.version === wanted) ?? entries.find((entry) => entry.raw === loader.version);
  if (hit) return { kind: loader.kind, version: hit.version, raw: hit.raw, meta: hit.meta };
  return loader.kind === "forge" ? { kind: "forge", version: wanted, raw: `${mcVersion}-${wanted}` } : { kind: "neoforge", version: wanted, raw: wanted };
}

function deriveName(manifest: PackManifest, taken: string[]): { id: string; display?: string } {
  let id = uniqueName(manifest.name.slice(0, 70), taken);
  if (validateInstanceName(id)) id = uniqueName("整合包", taken);
  return { id, display: id !== manifest.name ? manifest.name : undefined };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function toStored(file: PackFile): StoredFile {
  return { path: file.path, urls: file.urls, size: file.size, hashes: file.hashes, label: file.label, pageUrl: file.pageUrl, restricted: file.restricted, optional: file.optional };
}

function itemsFor(deps: PackDeps, gameDir: string, files: StoredFile[]): DownloadItem[] {
  const router = deps.install.env.router;
  return files.map((file) => ({
    urls: dedupe(file.urls.flatMap((url) => router.any(url))),
    dest: safeJoin(gameDir, file.path),
    size: file.size,
    hash: file.hashes,
    label: file.label ?? basename(file.path),
    group: file.path.split("/")[0],
  }));
}

function failuresFrom(files: StoredFile[], failed: { item: DownloadItem; error: string }[], gameDir: string): PackFailure[] {
  const byDest = new Map(files.map((file) => [safeJoin(gameDir, file.path), file]));
  return failed.map(({ item, error }) => {
    const file = byDest.get(item.dest);
    return { path: file?.path ?? item.dest, label: file?.label, error, pageUrl: file?.pageUrl, restricted: file?.restricted };
  });
}

/**
 * Install a modpack archive as a new instance: game + loader, then every pack file with parallel lanes, then
 * the archive's override folders. The instance is deleted when the run is cancelled or breaks; when only some
 * files could not be fetched it stays (marked incomplete) so a repair can finish the job.
 */
export async function installPack(deps: PackDeps, request: PackInstallRequest): Promise<PackInstallResult> {
  const { hooks, signal } = request;
  const env = deps.install.env;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    hooks?.warning?.(message);
  };

  hooks?.stage?.("pack-read");
  const pack = await openPack(request.file, { allowHosts: request.allowHosts });
  let createdId: string | undefined;
  try {
    const { manifest } = pack;
    for (const message of manifest.warnings) warn(message);

    const taken = await deps.install.instances.names();
    let id: string;
    let display: string | undefined;
    if (request.name !== undefined) {
      const problem = validateInstanceName(request.name);
      if (problem) throw new Error(problem);
      if (taken.some((name) => name.toLowerCase() === request.name!.toLowerCase())) throw new Error(`已存在名为“${request.name}”的实例`);
      id = request.name;
    } else ({ id, display } = deriveName(manifest, taken));

    hooks?.stage?.("pack-resolve");
    let files = manifest.files;
    let unresolved: UnresolvedFile[] = [];
    if (files.some((file) => file.curseforge)) {
      const resolved = await resolveCurseForgeFiles(deps.curseforge, files, { signal, instanceId: id, warn });
      files = resolved.files;
      unresolved = resolved.unresolved;
      for (const entry of unresolved) warn(`无法获取 “${entry.name ?? `#${entry.projectId}`}”：${entry.reason}`);
    }
    const skipList = Array.isArray(request.skipOptional) ? new Set(request.skipOptional.map((path) => path.toLowerCase())) : undefined;
    const selected: PackFile[] = [];
    for (const file of files) {
      const verdict = checkPackPath(file.path, id);
      if (!verdict.ok) {
        warn(`已跳过 ${file.path || "未命名文件"}：${verdict.reason}`);
        continue;
      }
      if (file.optional && (request.skipOptional === true || skipList?.has(verdict.path.toLowerCase()))) continue;
      selected.push({ ...file, path: verdict.path });
    }

    const loader = manifest.loader ? await resolveLoaderChoice({ ...deps.install.meta, signal }, manifest.mcVersion, manifest.loader) : undefined;

    await installInstance(deps.install, { name: id, mcVersion: manifest.mcVersion, loader, isolation: "on", signal, hooks, officialFallback: true });
    createdId = id;
    const gameDir = versionDir(env.root, id);
    const origin: ModpackOrigin = { ...manifest.origin, ...request.origin, source: request.origin?.source ?? manifest.origin.source };
    const stored = selected.map(toStored);

    // Record what we are about to do first, so an interrupted install can be repaired.
    const state: PackState = { version: 1, origin, mcVersion: manifest.mcVersion, files: stored, failed: [], unresolved, complete: false, updatedAt: Date.now() };
    await writeJsonAtomic(packStatePath(env.root, id), state);

    hooks?.stage?.("pack-files");
    const concurrency = request.concurrency ?? deps.concurrency?.();
    const run = await env.engine.run(itemsFor(deps, gameDir, stored), {
      signal,
      concurrency,
      onProgress: (progress) => hooks?.progress?.(progress, "pack-files"),
      onFile: (event) => hooks?.file?.(event),
    });
    if (run.cancelled) throw Object.assign(new Error("已取消"), { name: "AbortError" });
    const failed = failuresFrom(stored, run.failed, gameDir);

    hooks?.stage?.("pack-overrides");
    let overrideFiles = 0;
    let rejected = 0;
    for (const prefix of manifest.overrides) {
      const lower = prefix.toLowerCase();
      overrideFiles += await pack.zip.extractTo(gameDir, {
        signal,
        map: (entry) => {
          if (!entry.name.toLowerCase().startsWith(lower)) return undefined;
          const relative = entry.name.slice(prefix.length);
          if (!relative) return undefined;
          const verdict = checkPackPath(relative, id);
          if (!verdict.ok) {
            rejected++;
            return undefined;
          }
          return verdict.path;
        },
      });
    }
    if (rejected) warn(`整合包里有 ${rejected} 个文件的路径不安全或会覆盖启动器自己的文件，已跳过`);

    hooks?.stage?.("pack-finish");
    const settings = manifest.settings;
    await deps.install.instances.saveConfig(id, {
      isolation: "on",
      displayName: display,
      modpack: origin,
      memory: settings?.memoryMb,
      jvmArgs: settings?.jvmArgs,
      width: settings?.width,
      height: settings?.height,
      note: manifest.summary,
    });
    deps.install.instances.invalidate(id);

    const requiredFailures = failed.filter((entry) => !stored.find((file) => file.path === entry.path)?.optional);
    const complete = requiredFailures.length === 0 && unresolved.length === 0;
    await writeJsonAtomic(packStatePath(env.root, id), { ...state, failed, complete, updatedAt: Date.now() } satisfies PackState);
    return {
      id,
      name: manifest.name,
      mcVersion: manifest.mcVersion,
      loader,
      totalFiles: stored.length,
      downloaded: run.downloaded,
      skipped: run.skipped,
      overrideFiles,
      failed,
      unresolved,
      complete,
      warnings,
    };
  } catch (error) {
    if (createdId) await removeRecursive(versionDir(env.root, createdId)).catch(() => {});
    deps.install.instances.invalidate(createdId);
    throw error;
  } finally {
    pack.close();
  }
}

export interface RepairResult {
  total: number;
  downloaded: number;
  alreadyOk: number;
  failed: PackFailure[];
  complete: boolean;
}

/** Check every file a pack installed and download whatever is missing or damaged. */
export async function repairPack(
  deps: PackDeps,
  id: string,
  options: { signal?: AbortSignal; hooks?: PackHooks; verify?: "size" | "hash"; concurrency?: number } = {},
): Promise<RepairResult> {
  const env = deps.install.env;
  const state = await readPackState(env.root, id);
  if (!state) throw new PackError("这个实例不是通过整合包安装的（没有找到安装记录）", "failed");
  const gameDir = versionDir(env.root, id);
  options.hooks?.stage?.("pack-files");
  const items = itemsFor(deps, gameDir, state.files).map((item) => ({ ...item, verify: options.verify ?? "size" }));
  const run = await env.engine.run(items, {
    signal: options.signal,
    concurrency: options.concurrency ?? deps.concurrency?.(),
    onProgress: (progress) => options.hooks?.progress?.(progress, "pack-files"),
    onFile: (event) => options.hooks?.file?.(event),
  });
  if (run.cancelled) throw Object.assign(new Error("已取消"), { name: "AbortError" });
  const failed = failuresFrom(state.files, run.failed, gameDir);
  const complete = failed.every((entry) => state.files.find((file) => file.path === entry.path)?.optional) && state.unresolved.length === 0;
  await writeJsonAtomic(packStatePath(env.root, id), { ...state, failed, complete, updatedAt: Date.now() } satisfies PackState);
  return { total: state.files.length, downloaded: run.downloaded, alreadyOk: run.skipped, failed, complete };
}

export interface AdoptResult {
  adopted: string[];
  rejected: { file: string; reason: string }[];
  remaining: PackFailure[];
}

/**
 * Files the author does not allow launchers to fetch must be downloaded in a browser. This matches files the
 * person downloaded to the failed entries by file name, checks them against the known hash, and puts them in place.
 */
export async function adoptManualFiles(deps: PackDeps, id: string, sources: string[]): Promise<AdoptResult> {
  const env = deps.install.env;
  const state = await readPackState(env.root, id);
  if (!state) throw new PackError("这个实例不是通过整合包安装的（没有找到安装记录）", "failed");
  const gameDir = versionDir(env.root, id);
  const adopted: string[] = [];
  const rejected: AdoptResult["rejected"] = [];
  let failed = [...state.failed];
  for (const source of sources) {
    const name = basename(source).toLowerCase();
    const match = failed.find((entry) => basename(entry.path).toLowerCase() === name);
    if (!match) {
      rejected.push({ file: source, reason: "没有哪个缺失的文件叫这个名字" });
      continue;
    }
    const stored = state.files.find((file) => file.path === match.path);
    try {
      if (!(await stat(source)).isFile()) throw new Error("不是文件");
      const algorithm = (["sha512", "sha256", "sha1", "md5"] as const).find((key) => stored?.hashes?.[key]);
      if (algorithm && (await hashFile(source, algorithm)).toLowerCase() !== stored!.hashes![algorithm]!.toLowerCase()) {
        rejected.push({ file: source, reason: "文件内容与整合包要求的版本不一致（校验和不同）" });
        continue;
      }
      const dest = safeJoin(gameDir, match.path);
      await ensureDir(dirname(dest));
      await copyFile(source, dest);
      adopted.push(match.path);
      failed = failed.filter((entry) => entry !== match);
    } catch (error) {
      rejected.push({ file: source, reason: (error as Error).message });
    }
  }
  const complete = failed.every((entry) => state.files.find((file) => file.path === entry.path)?.optional) && state.unresolved.length === 0;
  await writeJsonAtomic(packStatePath(env.root, id), { ...state, failed, complete, updatedAt: Date.now() } satisfies PackState);
  return { adopted, rejected, remaining: failed };
}

/** Has this instance been created from a pack (so "repair" applies)? */
export async function isPackInstance(root: string, id: string): Promise<boolean> {
  return exists(packStatePath(root, id));
}
