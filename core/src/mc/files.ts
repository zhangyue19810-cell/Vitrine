import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { DownloadEngine, DownloadItem, Progress } from "../net/download";
import type { HttpClient } from "../net/http";
import type { SourceRouter } from "../net/sources";
import { throwIfAborted } from "../util/async";
import { ensureDir, exists, fileSize } from "../util/fsx";
import type { ScopedLog } from "../util/log";
import { currentOs, type OsInfo } from "../util/os";
import { assetIndexItem, assetIndexPath, assetObjectItems, readAssetIndex } from "./assets";
import { defaultRuleContext } from "./rules";
import {
  librariesDir,
  resolveLibraries,
  resolveVersion,
  versionDir,
  versionJarPath,
  type LibraryFile,
  type ResolvedVersion,
} from "./version-json";

/** Everything the Minecraft layer needs to touch the network and the game directory. */
export interface GameEnv {
  root: string;
  http: HttpClient;
  router: SourceRouter;
  engine: DownloadEngine;
  log: ScopedLog;
  os?: OsInfo;
}

export function libraryItems(env: GameEnv, libs: LibraryFile[], verify?: "size" | "hash"): DownloadItem[] {
  const items: DownloadItem[] = [];
  for (const lib of libs) {
    if (!lib.url) continue;
    items.push({
      urls: [...new Set([...env.router.candidates(lib.url), ...(lib.fallbackUrls ?? []).flatMap((url) => env.router.candidates(url))])],
      dest: join(librariesDir(env.root), lib.path),
      size: lib.size,
      hash: { sha1: lib.sha1, sha256: lib.sha256, sha512: lib.sha512, md5: lib.md5 },
      label: lib.path.split("/").pop(),
      group: "libraries",
      verify,
    });
  }
  return items;
}

/** Files an installer is supposed to have produced that are not on disk. */
export async function missingLocalLibraries(env: GameEnv, libs: LibraryFile[]): Promise<LibraryFile[]> {
  const missing: LibraryFile[] = [];
  for (const lib of libs) {
    if (lib.url) continue;
    if (!(await exists(join(librariesDir(env.root), lib.path)))) missing.push(lib);
  }
  return missing;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  verify?: "size" | "hash";
  concurrency?: number;
  onStage?: (stage: "files" | "assets") => void;
  onProgress?: (progress: Progress, stage: "files" | "assets") => void;
  skipAssets?: boolean;
}

export interface CompleteResult {
  version: ResolvedVersion;
  libraries: LibraryFile[];
  missingLocal: LibraryFile[];
  downloaded: number;
  skipped: number;
}

/**
 * Make an installed version launchable: client jar, libraries, logging config, asset index and asset objects.
 * Idempotent; with verify "hash" it doubles as a repair pass.
 */
export async function completeVersion(env: GameEnv, id: string, options: CompleteOptions = {}): Promise<CompleteResult> {
  const os = env.os ?? currentOs();
  const ctx = defaultRuleContext();
  ctx.os = os;
  const version = await resolveVersion(env.root, id);
  const libraries = resolveLibraries(version, ctx);
  const items: DownloadItem[] = [];

  const ownJar = versionJarPath(env.root, id);
  const client = version.downloads?.client;
  if (!(await exists(ownJar)) || (options.verify === "hash" && client?.sha1)) {
    const parentJar = versionJarPath(env.root, version.jar ?? version.rootId);
    if (version.rootId !== id && (await exists(parentJar)) && (!client?.size || (await fileSize(parentJar)) === client.size)) {
      await ensureDir(versionDir(env.root, id));
      await copyFile(parentJar, ownJar);
    } else if (client?.url) {
      items.push({
        urls: env.router.candidates(client.url),
        dest: ownJar,
        size: client.size,
        hash: { sha1: client.sha1 },
        label: `${id}.jar`,
        group: "client",
        verify: options.verify,
      });
    } else {
      throw new Error(`Client jar of "${id}" is missing and the version JSON has no download for it`);
    }
  }
  items.push(...libraryItems(env, libraries, options.verify));

  const logFile = version.logging?.client?.file;
  if (logFile?.url) {
    items.push({
      urls: env.router.candidates(logFile.url),
      dest: join(env.root, "assets", "log_configs", logFile.id),
      size: logFile.size,
      hash: { sha1: logFile.sha1 },
      label: logFile.id,
      group: "assets",
      verify: options.verify,
    });
  }
  if (version.assetIndex) items.push(assetIndexItem(env.root, version.assetIndex, env.router));

  let downloaded = 0;
  let skipped = 0;
  options.onStage?.("files");
  const first = await env.engine.run(items, {
    signal: options.signal,
    concurrency: options.concurrency,
    onProgress: (progress) => options.onProgress?.(progress, "files"),
  });
  throwIfAborted(options.signal);
  if (!first.ok) throw new Error(`Failed to download ${first.failed.length} file(s): ${first.failed[0]?.item.dest} — ${first.failed[0]?.error}`);
  downloaded += first.downloaded;
  skipped += first.skipped;

  if (!options.skipAssets && version.assetIndex) {
    options.onStage?.("assets");
    const index = await readAssetIndex(env.root, version.assetIndex.id);
    const assets = assetObjectItems(env.root, index, env.router).map((item) => ({ ...item, verify: options.verify }));
    const second = await env.engine.run(assets, {
      signal: options.signal,
      concurrency: options.concurrency,
      onProgress: (progress) => options.onProgress?.(progress, "assets"),
    });
    throwIfAborted(options.signal);
    if (!second.ok) throw new Error(`Failed to download ${second.failed.length} asset(s): ${second.failed[0]?.item.dest} — ${second.failed[0]?.error}`);
    downloaded += second.downloaded;
    skipped += second.skipped;
  }

  const missingLocal = await missingLocalLibraries(env, libraries);
  env.log.info(`version ${id}: ${downloaded} downloaded, ${skipped} already present, ${missingLocal.length} installer-provided libraries missing`);
  return { version, libraries, missingLocal, downloaded, skipped };
}

export { assetIndexPath };
