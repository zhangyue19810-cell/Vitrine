import { normalizePackPath } from "./guard";
import { ORIGIN_SOURCE, PackError, hashSpecFrom, type PackFile, type PackLoader, type PackManifest } from "./types";

export const MRPACK_INDEX = "modrinth.index.json";

/** Hosts the Modrinth pack format allows downloads from; anything else must be refused by launchers. */
export const MRPACK_ALLOWED_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

interface RawFile {
  path?: unknown;
  hashes?: Record<string, unknown>;
  env?: { client?: string; server?: string };
  downloads?: unknown;
  fileSize?: unknown;
}

interface RawIndex {
  formatVersion?: number;
  game?: string;
  versionId?: string;
  name?: string;
  summary?: string;
  files?: RawFile[];
  dependencies?: Record<string, string>;
}

const LOADER_KEYS: [string, PackLoader["kind"]][] = [
  ["fabric-loader", "fabric"],
  ["quilt-loader", "quilt"],
  ["neoforge", "neoforge"],
  ["forge", "forge"],
];

function allowedUrl(url: unknown, hosts: Set<string>): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
    return hosts.has(parsed.hostname.toLowerCase()) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `modrinth.index.json` into the shared manifest shape. */
export function parseMrpackIndex(raw: unknown, options: { allowHosts?: string[] } = {}): PackManifest {
  if (!raw || typeof raw !== "object") throw new PackError("modrinth.index.json 不是有效的 JSON 对象");
  const index = raw as RawIndex;
  if (index.game && index.game !== "minecraft") throw new PackError(`这个整合包面向“${index.game}”，不是 Minecraft`, "unsupported");
  const dependencies = index.dependencies ?? {};
  const mcVersion = dependencies.minecraft;
  if (typeof mcVersion !== "string" || !mcVersion) throw new PackError("整合包没有声明 Minecraft 版本");
  if (typeof index.name !== "string" || !index.name.trim()) throw new PackError("整合包缺少名称");

  const warnings: string[] = [];
  if (index.formatVersion !== undefined && index.formatVersion !== 1) {
    warnings.push(`整合包格式版本为 ${index.formatVersion}（已知为 1），部分内容可能无法正确安装`);
  }

  const loaders = LOADER_KEYS.filter(([key]) => typeof dependencies[key] === "string").map(([key, kind]) => ({ kind, version: dependencies[key] }));
  if (loaders.length > 1) warnings.push(`整合包同时声明了多个加载器（${loaders.map((l) => l.kind).join("、")}），只会安装 ${loaders[0].kind}`);
  const known = new Set(["minecraft", ...LOADER_KEYS.map(([key]) => key)]);
  for (const key of Object.keys(dependencies)) if (!known.has(key)) warnings.push(`未知的依赖项 “${key}” 已被忽略`);

  const hosts = new Set([...MRPACK_ALLOWED_HOSTS, ...(options.allowHosts ?? [])].map((host) => host.toLowerCase()));
  const files: PackFile[] = [];
  const seen = new Set<string>();
  let serverOnly = 0;
  let untrusted = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const entry of index.files ?? []) {
    if (entry.env?.client === "unsupported") {
      serverOnly++;
      continue;
    }
    let path: string;
    try {
      path = normalizePackPath(String(entry.path ?? ""));
    } catch {
      invalid++;
      continue;
    }
    const urls = (Array.isArray(entry.downloads) ? entry.downloads : []).map((url) => allowedUrl(url, hosts)).filter((url): url is string => Boolean(url));
    if (!urls.length) {
      untrusted++;
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const hashes = hashSpecFrom(entry.hashes);
    const size = typeof entry.fileSize === "number" && entry.fileSize >= 0 ? entry.fileSize : undefined;
    files.push({ path, urls, size, hashes, optional: entry.env?.client === "optional", label: path.split("/").pop() });
  }
  if (serverOnly) warnings.push(`已跳过 ${serverOnly} 个仅服务端文件`);
  if (untrusted) warnings.push(`有 ${untrusted} 个文件的下载地址不在 Modrinth 允许的域名内，已跳过`);
  if (invalid) warnings.push(`有 ${invalid} 个文件路径不合法，已跳过`);
  if (duplicates) warnings.push(`有 ${duplicates} 个重复路径，只保留了第一个`);

  const name = index.name.trim();
  return {
    format: "mrpack",
    name,
    version: typeof index.versionId === "string" ? index.versionId : undefined,
    summary: typeof index.summary === "string" ? index.summary : undefined,
    mcVersion,
    loader: loaders[0],
    files,
    overrides: ["overrides/", "client-overrides/"],
    warnings,
    origin: { source: ORIGIN_SOURCE.mrpack, name, version: typeof index.versionId === "string" ? index.versionId : undefined },
  };
}
