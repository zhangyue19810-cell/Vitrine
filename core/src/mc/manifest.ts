import { join } from "node:path";
import type { HttpClient } from "../net/http";
import type { SourceRouter } from "../net/sources";
import { hashBuffer, readJsonOr, writeJsonAtomic } from "../util/fsx";
import { nullLog, type ScopedLog } from "../util/log";
import { isAbort } from "../util/async";
import type { ManifestEntry, VersionJson, VersionManifest } from "./types";

export const OFFICIAL_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const OFFICIAL_PACKAGES = "https://piston-meta.mojang.com/v1/packages";

interface CachedManifest {
  fetchedAt: number;
  manifest: VersionManifest;
}

/**
 * Mirrors rewrite the `url` fields in the manifest to point at themselves. Rebuilding the official URL from
 * the JSON hash lets the SourceRouter keep both the mirror and the official source as candidates.
 */
export function normalizeEntry(entry: ManifestEntry): ManifestEntry {
  if (entry.sha1 && !/\.mojang\.com$/i.test(hostOf(entry.url))) {
    return { ...entry, url: `${OFFICIAL_PACKAGES}/${entry.sha1}/${entry.id}.json` };
  }
  return entry;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export class VersionCatalog {
  private memory?: CachedManifest;

  constructor(
    private readonly http: HttpClient,
    private readonly router: SourceRouter,
    private readonly cacheFile: string,
    private readonly log: ScopedLog = nullLog,
  ) {}

  /** Fetch the manifest from the first reachable source, falling back to the last cached copy. */
  async list(options: { force?: boolean; maxAgeMs?: number; signal?: AbortSignal } = {}): Promise<VersionManifest> {
    const maxAge = options.maxAgeMs ?? 10 * 60_000;
    if (!options.force && this.memory && Date.now() - this.memory.fetchedAt < maxAge) return this.memory.manifest;
    let lastError: unknown;
    for (const url of this.router.candidates(OFFICIAL_MANIFEST)) {
      try {
        const manifest = await this.http.getJson<VersionManifest>(url, { signal: options.signal, timeoutMs: 15_000 });
        if (!manifest?.versions?.length) throw new Error("manifest is empty");
        manifest.versions = manifest.versions.map(normalizeEntry);
        this.memory = { fetchedAt: Date.now(), manifest };
        await writeJsonAtomic(this.cacheFile, this.memory, false).catch(() => {});
        return manifest;
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
        this.log.warn(`version manifest from ${url} failed: ${(error as Error).message}`);
      }
    }
    const cached = await readJsonOr<CachedManifest | undefined>(this.cacheFile, undefined);
    if (cached?.manifest?.versions?.length) {
      this.log.warn("using cached version manifest (offline?)");
      this.memory = { fetchedAt: 0, manifest: cached.manifest };
      return cached.manifest;
    }
    throw new Error(`Cannot load the Minecraft version list: ${(lastError as Error | undefined)?.message ?? "no source reachable"}`);
  }

  async find(id: string, signal?: AbortSignal): Promise<ManifestEntry | undefined> {
    const manifest = await this.list({ signal });
    return manifest.versions.find((entry) => entry.id === id);
  }

  /**
   * Download a version JSON. A hash mismatch is tolerated as a last resort because some mirrors reformat the
   * file; anything that is not valid version JSON is always rejected.
   */
  async fetchVersionJson(entry: ManifestEntry, signal?: AbortSignal): Promise<VersionJson> {
    return fetchJsonWithFailover<VersionJson>(
      this.http,
      this.router.candidates(entry.url),
      entry.sha1,
      (json) => Boolean(json && typeof json === "object" && (json.mainClass !== undefined || json.inheritsFrom)),
      this.log,
      signal,
    );
  }
}

export async function fetchJsonWithFailover<T>(
  http: HttpClient,
  urls: string[],
  sha1: string | undefined,
  validate: (json: T) => boolean,
  log: ScopedLog = nullLog,
  signal?: AbortSignal,
): Promise<T> {
  let soft: T | undefined;
  let lastError: unknown;
  for (const url of urls) {
    try {
      const buffer = await http.getBuffer(url, { signal, timeoutMs: 20_000, headers: { "accept-encoding": "gzip" } });
      const text = buffer.toString("utf8").replace(/^﻿/, "");
      const json = JSON.parse(text) as T;
      if (!validate(json)) throw new Error("unexpected JSON shape");
      if (sha1 && hashBuffer(buffer, "sha1") !== sha1.toLowerCase()) {
        log.warn(`hash mismatch for ${url}`);
        soft ??= json;
        continue;
      }
      return json;
    } catch (error) {
      if (isAbort(error)) throw error;
      lastError = error;
      log.warn(`${url} failed: ${(error as Error).message}`);
    }
  }
  if (soft !== undefined) return soft;
  throw new Error(`Download failed from every source: ${(lastError as Error | undefined)?.message ?? "unknown error"}`);
}

export function versionsCacheFile(cacheDir: string): string {
  return join(cacheDir, "version_manifest_v2.json");
}
