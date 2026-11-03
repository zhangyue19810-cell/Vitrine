import { symlink, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DownloadEngine, DownloadItem, Progress } from "../net/download";
import type { HttpClient } from "../net/http";
import type { SourceRouter } from "../net/sources";
import { fetchJsonWithFailover } from "../mc/manifest";
import { ensureDir, exists, readJsonOr, removeRecursive, safeJoin, writeJsonAtomic } from "../util/fsx";
import type { ScopedLog } from "../util/log";
import { nullLog } from "../util/log";
import { currentOs, exeName, mojangRuntimePlatform, type OsInfo } from "../util/os";

export const RUNTIME_INDEX_URL = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

interface RuntimeEntry {
  availability?: { group: number; progress: number };
  manifest: { sha1: string; size: number; url: string };
  version: { name: string; released: string };
}

type RuntimeIndex = Record<string, Record<string, RuntimeEntry[]>>;

interface RuntimeManifest {
  files: Record<
    string,
    {
      type: "directory" | "file" | "link";
      executable?: boolean;
      target?: string;
      downloads?: { raw?: { sha1: string; size: number; url: string }; lzma?: { sha1: string; size: number; url: string } };
    }
  >;
}

/** Component names Mojang uses for each Java major, for when a profile does not name one. */
export function componentForMajor(major: number): string {
  if (major <= 8) return "jre-legacy";
  if (major <= 16) return "java-runtime-alpha";
  if (major <= 17) return "java-runtime-gamma";
  if (major <= 21) return "java-runtime-delta";
  return "java-runtime-epsilon";
}

export interface RuntimeInstallOptions {
  root: string;
  component: string;
  http: HttpClient;
  router: SourceRouter;
  engine: DownloadEngine;
  os?: OsInfo;
  log?: ScopedLog;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export function runtimeHome(root: string, component: string, os: OsInfo = currentOs()): string {
  return join(root, "runtime", component, mojangRuntimePlatform(os), component);
}

export function runtimeExecutable(root: string, component: string, os: OsInfo = currentOs()): string {
  return join(runtimeHome(root, component, os), "bin", exeName("java", os));
}

/** Download Mojang's Java runtime for this platform into `<root>/runtime/...` (same layout as the official launcher). */
export async function installMojangRuntime(options: RuntimeInstallOptions): Promise<{ home: string; executable: string; version: string }> {
  const os = options.os ?? currentOs();
  const log = options.log ?? nullLog;
  const platform = mojangRuntimePlatform(os);
  const index = await fetchJsonWithFailover<RuntimeIndex>(
    options.http,
    options.router.candidates(RUNTIME_INDEX_URL),
    undefined,
    (json) => Boolean(json && typeof json === "object"),
    log,
    options.signal,
  );
  const entry = index[platform]?.[options.component]?.[0];
  if (!entry) throw new Error(`Mojang offers no "${options.component}" runtime for ${platform}`);

  const home = runtimeHome(options.root, options.component, os);
  const markerPath = join(dirname(home), `${options.component}.version`);
  const marker = await readJsonOr<{ sha1?: string }>(markerPath, {});
  const executable = join(home, "bin", exeName("java", os));
  if (marker.sha1 === entry.manifest.sha1 && (await exists(executable))) {
    return { home, executable, version: entry.version.name };
  }

  const manifest = await fetchJsonWithFailover<RuntimeManifest>(
    options.http,
    options.router.candidates(entry.manifest.url),
    entry.manifest.sha1,
    (json) => Boolean(json?.files),
    log,
    options.signal,
  );
  await ensureDir(home);
  const items: DownloadItem[] = [];
  const links: { path: string; target: string }[] = [];
  for (const [relative, file] of Object.entries(manifest.files)) {
    const target = safeJoin(home, relative);
    if (file.type === "directory") {
      await mkdir(target, { recursive: true });
    } else if (file.type === "link" && file.target) {
      links.push({ path: target, target: file.target });
    } else if (file.type === "file" && file.downloads?.raw) {
      const raw = file.downloads.raw;
      items.push({
        urls: options.router.candidates(raw.url),
        dest: target,
        size: raw.size,
        hash: { sha1: raw.sha1 },
        mode: file.executable ? 0o755 : undefined,
        label: relative,
        group: "java",
      });
    }
  }
  const result = await options.engine.run(items, { signal: options.signal, onProgress: options.onProgress });
  if (!result.ok) throw new Error(`Java runtime download failed: ${result.failed[0]?.error ?? "unknown error"}`);
  if (os.name !== "windows") {
    for (const link of links) {
      await ensureDir(dirname(link.path));
      await removeRecursive(link.path);
      await symlink(link.target, link.path).catch(() => {});
    }
  }
  if (!(await exists(executable))) throw new Error("The downloaded Java runtime has no java executable");
  await writeFile(join(dirname(home), `${options.component}.sha1`), entry.manifest.sha1).catch(() => {});
  await writeJsonAtomic(markerPath, { sha1: entry.manifest.sha1, version: entry.version.name });
  log.info(`installed ${options.component} ${entry.version.name} to ${home}`);
  return { home, executable, version: entry.version.name };
}
