import type { CurseForgeClient, CfFile, CfMod } from "../content/curseforge";
import { CF_CLASS, cdnUrl, cfHashes } from "../content/curseforge";
import { checkPackPath } from "./guard";
import { ORIGIN_SOURCE, PackError, type PackFile, type PackLoader, type PackManifest } from "./types";

interface RawCfManifest {
  manifestType?: string;
  manifestVersion?: number;
  name?: string;
  version?: string;
  author?: string;
  minecraft?: { version?: string; modLoaders?: { id?: string; primary?: boolean }[] };
  files?: { projectID?: number; fileID?: number; required?: boolean }[];
  overrides?: string;
}

export function parseLoaderId(id: string): PackLoader | undefined {
  const match = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id.trim());
  if (!match) return undefined;
  return { kind: match[1].toLowerCase() as PackLoader["kind"], version: match[2] };
}

/** Parse a CurseForge `manifest.json`. File entries stay unresolved (no path / URL yet). */
export function parseCurseForgeManifest(raw: unknown): PackManifest {
  if (!raw || typeof raw !== "object") throw new PackError("manifest.json 不是有效的 JSON 对象");
  const manifest = raw as RawCfManifest;
  if (manifest.manifestType && manifest.manifestType !== "minecraftModpack") throw new PackError(`不支持的清单类型：${manifest.manifestType}`, "unsupported");
  const mcVersion = manifest.minecraft?.version;
  if (typeof mcVersion !== "string" || !mcVersion) throw new PackError("整合包没有声明 Minecraft 版本");
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new PackError("整合包缺少名称");

  const warnings: string[] = [];
  const modLoaders = manifest.minecraft?.modLoaders ?? [];
  const primary = modLoaders.find((loader) => loader.primary) ?? modLoaders[0];
  let loader: PackLoader | undefined;
  if (primary?.id) {
    loader = parseLoaderId(primary.id);
    if (!loader) warnings.push(`不支持的加载器 “${primary.id}”，将只安装原版 Minecraft`);
  }
  if (modLoaders.length > 1) warnings.push("整合包声明了多个加载器，只会安装主加载器");

  const files: PackFile[] = [];
  const seen = new Set<number>();
  for (const entry of manifest.files ?? []) {
    if (!Number.isInteger(entry.projectID) || !Number.isInteger(entry.fileID)) continue;
    if (seen.has(entry.fileID!)) continue;
    seen.add(entry.fileID!);
    files.push({ path: "", urls: [], optional: entry.required === false, curseforge: { projectId: entry.projectID!, fileId: entry.fileID! } });
  }
  const folder = (manifest.overrides ?? "overrides").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "overrides";
  const name = manifest.name.trim();
  return {
    format: "curseforge",
    name,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    author: typeof manifest.author === "string" ? manifest.author : undefined,
    mcVersion,
    loader,
    files,
    overrides: [`${folder}/`],
    warnings,
    origin: { source: ORIGIN_SOURCE.curseforge, name, version: typeof manifest.version === "string" ? manifest.version : undefined },
  };
}

const CLASS_FOLDER: Record<number, string> = {
  [CF_CLASS.mod]: "mods",
  [CF_CLASS.resourcepack]: "resourcepacks",
  [CF_CLASS.shader]: "shaderpacks",
  [CF_CLASS.datapack]: "datapacks",
};

/** Where a CurseForge file belongs in the game directory. */
export function folderFor(classId: number | undefined, fileName: string): string {
  if (classId !== undefined && CLASS_FOLDER[classId]) return CLASS_FOLDER[classId];
  return /\.jar$/i.test(fileName) ? "mods" : "resourcepacks";
}

/** forgecdn serves the same path from two host names; offer both. */
export function cdnCandidates(file: Pick<CfFile, "id" | "fileName" | "downloadUrl">): string[] {
  const urls: string[] = [];
  const add = (url: string | null | undefined) => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  add(file.downloadUrl);
  const alt = (url: string) => (url.includes("//edge.forgecdn.net/") ? url.replace("//edge.forgecdn.net/", "//mediafilez.forgecdn.net/") : url.replace("//mediafilez.forgecdn.net/", "//edge.forgecdn.net/"));
  if (file.downloadUrl) add(alt(file.downloadUrl));
  add(cdnUrl(file));
  add(alt(cdnUrl(file)));
  return urls;
}

export interface UnresolvedFile {
  projectId: number;
  fileId: number;
  name?: string;
  reason: string;
  pageUrl?: string;
}

export interface CfResolveResult {
  files: PackFile[];
  unresolved: UnresolvedFile[];
}

/**
 * Turn `{projectID, fileID}` references into concrete files (path, URLs, hashes, size) using the CurseForge API
 * (or its mirror). Files whose author disallows third-party distribution get the public CDN path as a best-effort
 * URL and a page link, so the UI can fall back to a manual download.
 */
export async function resolveCurseForgeFiles(
  client: CurseForgeClient,
  files: PackFile[],
  options: { signal?: AbortSignal; instanceId: string; warn?: (message: string) => void },
): Promise<CfResolveResult> {
  const refs = files.filter((file) => file.curseforge);
  const passthrough = files.filter((file) => !file.curseforge);
  if (!refs.length) return { files: passthrough, unresolved: [] };

  let records: CfFile[];
  let mods: CfMod[];
  try {
    [records, mods] = await Promise.all([client.filesByIds(refs.map((ref) => ref.curseforge!.fileId), options.signal), client.mods([...new Set(refs.map((ref) => ref.curseforge!.projectId))], options.signal)]);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new PackError(`无法从 CurseForge 获取文件信息：${(error as Error).message}${client.hasKey ? "" : "（未配置 CurseForge API Key，且镜像不可用）"}`, client.hasKey ? "failed" : "no-api-key");
  }
  const fileById = new Map(records.map((record) => [record.id, record]));
  const modById = new Map(mods.map((mod) => [mod.id, mod]));

  const resolved: PackFile[] = [];
  const unresolved: UnresolvedFile[] = [];
  const taken = new Set<string>();
  for (const ref of refs) {
    const { projectId, fileId } = ref.curseforge!;
    const mod = modById.get(projectId);
    let record = fileById.get(fileId);
    if (!record) {
      try {
        record = await client.file(projectId, fileId, options.signal);
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
      }
    }
    const page = mod?.links?.websiteUrl ? `${mod.links.websiteUrl.replace(/\/+$/, "")}/files/${fileId}` : undefined;
    if (!record || record.isAvailable === false) {
      unresolved.push({ projectId, fileId, name: mod?.name, reason: "这个文件已被作者删除或不可用", pageUrl: page });
      continue;
    }
    const verdict = checkPackPath(`${folderFor(mod?.classId, record.fileName)}/${record.fileName}`, options.instanceId);
    if (!verdict.ok) {
      unresolved.push({ projectId, fileId, name: mod?.name, reason: verdict.reason, pageUrl: page });
      continue;
    }
    if (taken.has(verdict.path.toLowerCase())) continue; // two references to the same file name
    taken.add(verdict.path.toLowerCase());
    const blocked = !record.downloadUrl;
    resolved.push({
      path: verdict.path,
      urls: cdnCandidates(record),
      size: record.fileLength > 0 ? record.fileLength : undefined,
      hashes: cfHashes(record),
      optional: ref.optional,
      label: mod?.name ? `${mod.name} — ${record.fileName}` : record.fileName,
      pageUrl: page,
      restricted: blocked,
      curseforge: ref.curseforge,
    });
    if (blocked) options.warn?.(`“${mod?.name ?? record.fileName}” 的作者不允许第三方分发，将尝试公共 CDN，失败时需要手动下载`);
  }
  return { files: [...passthrough, ...resolved], unresolved };
}
