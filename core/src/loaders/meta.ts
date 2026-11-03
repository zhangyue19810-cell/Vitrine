import type { HttpClient } from "../net/http";
import type { SourceRouter } from "../net/sources";
import { isAbort } from "../util/async";
import { nullLog, type ScopedLog } from "../util/log";
import { compareVersions } from "../util/version";
import type { LoaderKind } from "../mc/types";

export interface MetaDeps {
  http: HttpClient;
  router: SourceRouter;
  log?: ScopedLog;
  signal?: AbortSignal;
  /** Settings accessor so OptiFine (mirror-only) can find the mirror root. */
  mirrorBase: () => string;
}

export interface LoaderVersion {
  loader: LoaderKind;
  /** Loader version as shown to the user (Forge: "47.2.0", NeoForge: "21.1.77", OptiFine: "HD_U_I6"). */
  version: string;
  mcVersion: string;
  stable?: boolean;
  recommended?: boolean;
  /** Original maven version string (Forge "1.20.1-47.2.0", NeoForge "21.1.77"). */
  raw?: string;
  /** OptiFine: release channel; Forge: artifact id. */
  meta?: Record<string, string>;
}

interface Cached<T> {
  at: number;
  value: T;
}
const cache = new Map<string, Cached<unknown>>();
const TTL = 10 * 60_000;

async function cached<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await produce();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearMetaCache() {
  cache.clear();
}

/** Try each candidate URL in order and return the first body that satisfies `parse`. */
export async function fetchFirst<T>(deps: MetaDeps, urls: string[], parse: (text: string) => T): Promise<T> {
  const log = deps.log ?? nullLog;
  let lastError: unknown;
  for (const url of urls) {
    try {
      const text = await deps.http.getText(url, { signal: deps.signal, timeoutMs: 15_000 });
      return parse(text);
    } catch (error) {
      if (isAbort(error)) throw error;
      lastError = error;
      log.warn(`${url} failed: ${(error as Error).message}`);
    }
  }
  throw new Error(`Cannot reach any source: ${(lastError as Error | undefined)?.message ?? "no candidates"}`);
}

const parseJson = <T>(text: string): T => JSON.parse(text) as T;

// ---------------------------------------------------------------- Fabric / Quilt

const FABRIC = { meta: "https://meta.fabricmc.net/v2", maven: "https://maven.fabricmc.net/" };
const QUILT = { meta: "https://meta.quiltmc.org/v3", maven: "https://maven.quiltmc.org/repository/release/" };

export function fabricProfileUrl(kind: "fabric" | "quilt", mcVersion: string, loader: string): string {
  const base = kind === "fabric" ? FABRIC.meta : QUILT.meta;
  return `${base}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loader)}/profile/json`;
}

export async function listFabricLike(deps: MetaDeps, kind: "fabric" | "quilt", mcVersion: string): Promise<LoaderVersion[]> {
  const base = kind === "fabric" ? FABRIC.meta : QUILT.meta;
  return cached(`${kind}:${mcVersion}`, async () => {
    const url = `${base}/versions/loader/${encodeURIComponent(mcVersion)}`;
    const entries = await fetchFirst(deps, deps.router.candidates(url), (text) => parseJson<{ loader: { version: string; stable?: boolean } }[]>(text));
    return entries
      .map((entry) => ({ loader: kind, version: entry.loader.version, mcVersion, stable: entry.loader.stable ?? !/(beta|alpha|rc|pre)/i.test(entry.loader.version) }) as LoaderVersion)
      .sort((a, b) => compareVersions(b.version, a.version));
  });
}

/** Minecraft versions a Fabric-like loader supports. */
export async function listFabricLikeGames(deps: MetaDeps, kind: "fabric" | "quilt"): Promise<{ version: string; stable: boolean }[]> {
  const base = kind === "fabric" ? FABRIC.meta : QUILT.meta;
  return cached(`${kind}:games`, async () =>
    fetchFirst(deps, deps.router.candidates(`${base}/versions/game`), (text) => parseJson<{ version: string; stable: boolean }[]>(text)),
  );
}

// ---------------------------------------------------------------- Forge / NeoForge (maven metadata)

export const FORGE_MAVEN = "https://maven.minecraftforge.net/";
export const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/";

export function parseMavenMetadata(xml: string): string[] {
  const out: string[] = [];
  const re = /<version>\s*([^<\s]+)\s*<\/version>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out.push(match[1]);
  return out;
}

/** Forge versions look like "1.20.1-47.2.0" or "1.7.10-10.13.4.1614-1.7.10"; the middle part is the loader build. */
export function parseForgeVersion(raw: string): { mcVersion: string; version: string } | undefined {
  const parts = raw.split("-");
  if (parts.length < 2) return undefined;
  const mcVersion = parts[0];
  if (!/^\d+\.\d+/.test(mcVersion)) return undefined;
  return { mcVersion, version: parts[1] };
}

export async function listForge(deps: MetaDeps, mcVersion?: string): Promise<LoaderVersion[]> {
  const all = await cached("forge:all", async () => {
    const url = `${FORGE_MAVEN}net/minecraftforge/forge/maven-metadata.xml`;
    const raws = await fetchFirst(deps, deps.router.candidates(url), (text) => {
      const list = parseMavenMetadata(text);
      if (!list.length) throw new Error("empty metadata");
      return list;
    });
    let promos: Record<string, string> = {};
    try {
      promos = await fetchFirst(deps, ["https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"], (text) => parseJson<{ promos: Record<string, string> }>(text).promos);
    } catch {
      /* the recommended marker is optional */
    }
    const versions: LoaderVersion[] = [];
    for (const raw of raws) {
      const parsed = parseForgeVersion(raw);
      if (!parsed) continue;
      versions.push({
        loader: "forge",
        version: parsed.version,
        mcVersion: parsed.mcVersion,
        raw,
        recommended: promos[`${parsed.mcVersion}-recommended`] === parsed.version,
        stable: true,
        meta: { artifact: "forge" },
      });
    }
    return versions;
  });
  const filtered = mcVersion ? all.filter((entry) => entry.mcVersion === mcVersion) : all;
  return [...filtered].sort((a, b) => compareVersions(b.version, a.version));
}

/** NeoForge numbers its builds "<mc minor>.<mc patch>.<build>": 21.1.77 is for Minecraft 1.21.1. */
export function mcVersionOfNeoForge(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 26) return `${major}.${minor}`;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

export async function listNeoForge(deps: MetaDeps, mcVersion?: string): Promise<LoaderVersion[]> {
  const all = await cached("neoforge:all", async () => {
    const versions: LoaderVersion[] = [];
    const modern = await fetchFirst(deps, deps.router.candidates(`${NEOFORGE_MAVEN}net/neoforged/neoforge/maven-metadata.xml`), (text) => {
      const list = parseMavenMetadata(text);
      if (!list.length) throw new Error("empty metadata");
      return list;
    });
    for (const raw of modern) {
      const mc = mcVersionOfNeoForge(raw);
      if (!mc) continue;
      versions.push({ loader: "neoforge", version: raw, mcVersion: mc, raw, stable: !/(beta|alpha|snapshot)/i.test(raw), meta: { artifact: "neoforge" } });
    }
    // NeoForge for 1.20.1 was still published as net.neoforged:forge.
    try {
      const legacy = await fetchFirst(deps, deps.router.candidates(`${NEOFORGE_MAVEN}net/neoforged/forge/maven-metadata.xml`), parseMavenMetadata);
      for (const raw of legacy) {
        const parsed = parseForgeVersion(raw);
        if (parsed) versions.push({ loader: "neoforge", version: parsed.version, mcVersion: parsed.mcVersion, raw, stable: true, meta: { artifact: "forge" } });
      }
    } catch {
      /* optional */
    }
    return versions;
  });
  const filtered = mcVersion ? all.filter((entry) => entry.mcVersion === mcVersion) : all;
  return [...filtered].sort((a, b) => compareVersions(b.version, a.version));
}

export function forgeInstallerUrl(entry: LoaderVersion): string {
  const raw = entry.raw ?? `${entry.mcVersion}-${entry.version}`;
  return `${FORGE_MAVEN}net/minecraftforge/forge/${raw}/forge-${raw}-installer.jar`;
}

export function neoforgeInstallerUrl(entry: LoaderVersion): string {
  const raw = entry.raw ?? entry.version;
  const artifact = entry.meta?.artifact ?? "neoforge";
  return `${NEOFORGE_MAVEN}net/neoforged/${artifact}/${raw}/${artifact}-${raw}-installer.jar`;
}

// ---------------------------------------------------------------- OptiFine (BMCLAPI only)

export interface OptiFineEntry extends LoaderVersion {
  meta: { type: string; patch: string; filename: string; forge?: string };
}

export async function listOptiFine(deps: MetaDeps, mcVersion: string): Promise<OptiFineEntry[]> {
  return cached(`optifine:${mcVersion}`, async () => {
    const url = `${deps.mirrorBase().replace(/\/+$/, "")}/optifine/${encodeURIComponent(mcVersion)}`;
    const list = await fetchFirst(deps, [url], (text) => parseJson<{ mcversion: string; patch: string; type: string; filename: string; forge?: string }[]>(text));
    return list
      .map(
        (entry): OptiFineEntry => ({
          loader: "optifine",
          version: `${entry.type}_${entry.patch}`,
          mcVersion: entry.mcversion,
          stable: !/pre/i.test(entry.patch),
          meta: { type: entry.type, patch: entry.patch, filename: entry.filename, forge: entry.forge },
        }),
      )
      .sort((a, b) => compareVersions(b.meta.patch, a.meta.patch));
  });
}

export function optifineDownloadUrl(mirrorBase: string, mcVersion: string, type: string, patch: string): string {
  return `${mirrorBase.replace(/\/+$/, "")}/optifine/${encodeURIComponent(mcVersion)}/${encodeURIComponent(type)}/${encodeURIComponent(patch)}`;
}
