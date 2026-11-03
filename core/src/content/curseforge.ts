import type { HashSpec } from "../net/download";
import { apiJson, type ApiDeps } from "./api";

export const CURSEFORGE_API = "https://api.curseforge.com/v1";
export const MINECRAFT_GAME_ID = 432;

/** CurseForge class ids for Minecraft. */
export const CF_CLASS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552, world: 17, datapack: 6945 } as const;
/** modLoaderType values. */
export const CF_LOADER = { forge: 1, cauldron: 2, liteloader: 3, fabric: 4, quilt: 5, neoforge: 6 } as const;

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  releaseType: number;
  fileDate: string;
  fileLength: number;
  downloadCount?: number;
  downloadUrl: string | null;
  hashes: { value: string; algo: number }[];
  gameVersions: string[];
  dependencies?: { modId: number; relationType: number }[];
  isAvailable?: boolean;
}

export interface CfMod {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  logo?: { url: string; thumbnailUrl?: string };
  authors?: { name: string }[];
  categories?: { id: number; name: string }[];
  classId?: number;
  latestFiles?: CfFile[];
  latestFilesIndexes?: { gameVersion: string; fileId: number; modLoader?: number }[];
  links?: { websiteUrl?: string };
  allowModDistribution?: boolean | null;
  dateModified?: string;
}

export interface CfSearchOptions {
  query?: string;
  classId: number;
  gameVersion?: string;
  modLoader?: number;
  /** 1 Featured, 2 Popularity, 3 LastUpdated, 4 Name, 5 Author, 6 TotalDownloads */
  sortField?: number;
  index?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export function cfHashes(file: CfFile): HashSpec {
  const hashes: HashSpec = {};
  for (const hash of file.hashes ?? []) {
    if (hash.algo === 1) hashes.sha1 = hash.value;
    else if (hash.algo === 2) hashes.md5 = hash.value;
  }
  return hashes;
}

/**
 * CurseForge hides `downloadUrl` for files whose authors opted out of third-party distribution. The CDN path is
 * still predictable; the caller treats a download from it as best-effort.
 */
export function cdnUrl(file: Pick<CfFile, "id" | "fileName">): string {
  return `https://edge.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${encodeURIComponent(file.fileName)}`;
}

export class CurseForgeClient {
  constructor(
    private readonly deps: ApiDeps,
    private readonly getKey: () => string | undefined,
  ) {}

  get hasKey(): boolean {
    return Boolean(this.getKey()?.trim());
  }

  private request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const key = this.getKey()?.trim();
    return apiJson<T>(this.deps, `${CURSEFORGE_API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      body,
      signal,
      officialHeaders: key ? { "x-api-key": key } : undefined,
      officialUsable: Boolean(key),
    });
  }

  async search(options: CfSearchOptions): Promise<{ data: CfMod[]; pagination: { index: number; pageSize: number; totalCount: number } }> {
    const params = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(options.classId),
      searchFilter: options.query ?? "",
      sortField: String(options.sortField ?? (options.query ? 1 : 2)),
      sortOrder: "desc",
      index: String(options.index ?? 0),
      pageSize: String(options.pageSize ?? 20),
    });
    if (options.gameVersion) params.set("gameVersion", options.gameVersion);
    if (options.modLoader) params.set("modLoaderType", String(options.modLoader));
    return this.request(`/mods/search?${params}`, undefined, options.signal);
  }

  async mod(id: number, signal?: AbortSignal): Promise<CfMod> {
    return (await this.request<{ data: CfMod }>(`/mods/${id}`, undefined, signal)).data;
  }

  async mods(ids: number[], signal?: AbortSignal): Promise<CfMod[]> {
    if (!ids.length) return [];
    return (await this.request<{ data: CfMod[] }>("/mods", { modIds: ids, filterPcOnly: true }, signal)).data;
  }

  async files(id: number, filter: { gameVersion?: string; modLoader?: number; index?: number; pageSize?: number } = {}, signal?: AbortSignal): Promise<CfFile[]> {
    const params = new URLSearchParams({ index: String(filter.index ?? 0), pageSize: String(filter.pageSize ?? 50) });
    if (filter.gameVersion) params.set("gameVersion", filter.gameVersion);
    if (filter.modLoader) params.set("modLoaderType", String(filter.modLoader));
    return (await this.request<{ data: CfFile[] }>(`/mods/${id}/files?${params}`, undefined, signal)).data;
  }

  async file(modId: number, fileId: number, signal?: AbortSignal): Promise<CfFile> {
    return (await this.request<{ data: CfFile }>(`/mods/${modId}/files/${fileId}`, undefined, signal)).data;
  }

  async filesByIds(ids: number[], signal?: AbortSignal): Promise<CfFile[]> {
    const out: CfFile[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      out.push(...(await this.request<{ data: CfFile[] }>("/mods/files", { fileIds: ids.slice(i, i + 500) }, signal)).data);
    }
    return out;
  }

  async downloadUrl(modId: number, fileId: number, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return (await this.request<{ data: string }>(`/mods/${modId}/files/${fileId}/download-url`, undefined, signal)).data || undefined;
    } catch {
      return undefined;
    }
  }
}
