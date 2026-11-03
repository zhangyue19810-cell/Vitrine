import type { HashSpec } from "../net/download";
import { apiJson, type ApiDeps } from "./api";

export const MODRINTH_API = "https://api.modrinth.com/v2";

export type ModrinthProjectType = "mod" | "modpack" | "resourcepack" | "shader" | "datapack" | "plugin";

export interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  icon_url?: string;
  downloads: number;
  follows: number;
  categories: string[];
  versions: string[];
  project_type: ModrinthProjectType;
  date_modified: string;
  client_side?: string;
  server_side?: string;
}

export interface ModrinthSearch {
  hits: ModrinthHit[];
  offset: number;
  limit: number;
  total_hits: number;
}

export interface ModrinthFile {
  hashes: { sha1?: string; sha512?: string };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
}

export interface ModrinthDependency {
  version_id?: string | null;
  project_id?: string | null;
  file_name?: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  changelog?: string;
  game_versions: string[];
  loaders: string[];
  version_type: "release" | "beta" | "alpha";
  date_published: string;
  downloads: number;
  files: ModrinthFile[];
  dependencies: ModrinthDependency[];
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  body?: string;
  icon_url?: string;
  project_type: ModrinthProjectType;
  categories: string[];
  game_versions: string[];
  loaders: string[];
  downloads: number;
  followers: number;
  client_side?: string;
  server_side?: string;
  gallery?: { url: string; title?: string }[];
  source_url?: string;
  issues_url?: string;
  wiki_url?: string;
}

export interface SearchOptions {
  query?: string;
  type?: ModrinthProjectType;
  gameVersion?: string;
  loader?: string;
  categories?: string[];
  index?: "relevance" | "downloads" | "follows" | "newest" | "updated";
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}

const q = (value: string) => encodeURIComponent(value);

export class ModrinthClient {
  constructor(private readonly deps: ApiDeps) {}

  private get<T>(path: string, signal?: AbortSignal) {
    return apiJson<T>(this.deps, `${MODRINTH_API}${path}`, { signal });
  }

  private post<T>(path: string, body: unknown, signal?: AbortSignal) {
    return apiJson<T>(this.deps, `${MODRINTH_API}${path}`, { method: "POST", body, signal });
  }

  search(options: SearchOptions): Promise<ModrinthSearch> {
    const facets: string[][] = [];
    if (options.type) facets.push([`project_type:${options.type}`]);
    if (options.gameVersion) facets.push([`versions:${options.gameVersion}`]);
    if (options.loader) facets.push([`categories:${options.loader}`]);
    for (const category of options.categories ?? []) facets.push([`categories:${category}`]);
    const params = [
      `query=${q(options.query ?? "")}`,
      `index=${options.index ?? (options.query ? "relevance" : "downloads")}`,
      `offset=${options.offset ?? 0}`,
      `limit=${options.limit ?? 20}`,
      facets.length ? `facets=${q(JSON.stringify(facets))}` : "",
    ].filter(Boolean);
    return this.get<ModrinthSearch>(`/search?${params.join("&")}`, options.signal);
  }

  project(idOrSlug: string, signal?: AbortSignal): Promise<ModrinthProject> {
    return this.get<ModrinthProject>(`/project/${q(idOrSlug)}`, signal);
  }

  projects(ids: string[], signal?: AbortSignal): Promise<ModrinthProject[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.get<ModrinthProject[]>(`/projects?ids=${q(JSON.stringify(ids))}`, signal);
  }

  versions(projectId: string, filter: { loaders?: string[]; gameVersions?: string[] } = {}, signal?: AbortSignal): Promise<ModrinthVersion[]> {
    const params: string[] = [];
    if (filter.loaders?.length) params.push(`loaders=${q(JSON.stringify(filter.loaders))}`);
    if (filter.gameVersions?.length) params.push(`game_versions=${q(JSON.stringify(filter.gameVersions))}`);
    return this.get<ModrinthVersion[]>(`/project/${q(projectId)}/version${params.length ? `?${params.join("&")}` : ""}`, signal);
  }

  version(id: string, signal?: AbortSignal): Promise<ModrinthVersion> {
    return this.get<ModrinthVersion>(`/version/${q(id)}`, signal);
  }

  versionsByIds(ids: string[], signal?: AbortSignal): Promise<ModrinthVersion[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.get<ModrinthVersion[]>(`/versions?ids=${q(JSON.stringify(ids))}`, signal);
  }

  /** Identify local files: hash → the version that contains it. */
  async versionsByHashes(hashes: string[], algorithm: "sha1" | "sha512" = "sha1", signal?: AbortSignal): Promise<Record<string, ModrinthVersion>> {
    if (!hashes.length) return {};
    const out: Record<string, ModrinthVersion> = {};
    for (let i = 0; i < hashes.length; i += 500) {
      const chunk = hashes.slice(i, i + 500);
      Object.assign(out, await this.post<Record<string, ModrinthVersion>>("/version_files", { hashes: chunk, algorithm }, signal));
    }
    return out;
  }

  /** For each local file hash, the newest compatible version (when it differs from the installed one). */
  async latestForHashes(
    hashes: string[],
    filter: { loaders: string[]; gameVersions: string[] },
    algorithm: "sha1" | "sha512" = "sha1",
    signal?: AbortSignal,
  ): Promise<Record<string, ModrinthVersion>> {
    if (!hashes.length) return {};
    const out: Record<string, ModrinthVersion> = {};
    for (let i = 0; i < hashes.length; i += 500) {
      const chunk = hashes.slice(i, i + 500);
      Object.assign(out, await this.post<Record<string, ModrinthVersion>>("/version_files/update", { hashes: chunk, algorithm, loaders: filter.loaders, game_versions: filter.gameVersions }, signal));
    }
    return out;
  }
}

export function primaryFile(version: ModrinthVersion): ModrinthFile | undefined {
  return version.files.find((file) => file.primary) ?? version.files[0];
}

export function fileHashes(file: ModrinthFile): HashSpec {
  return { sha1: file.hashes.sha1, sha512: file.hashes.sha512 };
}

/** Modrinth's loader names for our loader kinds. */
export function modrinthLoader(kind: string): string | undefined {
  return { fabric: "fabric", quilt: "quilt", forge: "forge", neoforge: "neoforge", optifine: undefined, liteloader: "liteloader" }[kind];
}
