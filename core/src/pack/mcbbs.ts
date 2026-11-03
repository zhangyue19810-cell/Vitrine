import { normalizePackPath } from "./guard";
import { ORIGIN_SOURCE, PackError, type PackFile, type PackLoader, type PackManifest, type PackSettings } from "./types";

interface RawAddon {
  id?: string;
  version?: string;
}

interface RawFile {
  type?: string;
  path?: string;
  hash?: string;
  force?: boolean;
  projectID?: number;
  fileID?: number;
}

interface RawMcbbs {
  manifestType?: string;
  manifestVersion?: number;
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  fileApi?: string;
  addons?: RawAddon[];
  files?: RawFile[];
  launchInfo?: { minMemory?: number };
}

const LOADER_IDS: PackLoader["kind"][] = ["neoforge", "forge", "fabric", "quilt"];

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Parse the MCBBS launcher-pack metadata (`mcbbs.packmeta`). Files hosted on a `fileApi` and CurseForge references are supported. */
export function parseMcbbsPack(raw: unknown): PackManifest {
  if (!raw || typeof raw !== "object") throw new PackError("mcbbs.packmeta 不是有效的 JSON 对象");
  const meta = raw as RawMcbbs;
  const addons = new Map((meta.addons ?? []).filter((addon) => addon.id && addon.version).map((addon) => [String(addon.id).toLowerCase(), String(addon.version)]));
  const mcVersion = addons.get("game");
  if (!mcVersion) throw new PackError("整合包没有声明 Minecraft 版本");
  if (typeof meta.name !== "string" || !meta.name.trim()) throw new PackError("整合包缺少名称");

  const warnings: string[] = [];
  const loaders = LOADER_IDS.filter((kind) => addons.has(kind)).map((kind) => ({ kind, version: addons.get(kind)! }));
  if (loaders.length > 1) warnings.push(`声明了多个加载器（${loaders.map((l) => l.kind).join("、")}），只会安装 ${loaders[0].kind}`);
  for (const unsupported of ["optifine", "liteloader"]) if (addons.has(unsupported)) warnings.push(`不会自动安装 ${unsupported}，请在整合包安装后手动添加`);

  const files: PackFile[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of meta.files ?? []) {
    if (entry.type === "curseforge" && Number.isInteger(entry.projectID) && Number.isInteger(entry.fileID)) {
      if (!seen.has(`cf:${entry.fileID}`)) {
        seen.add(`cf:${entry.fileID}`);
        files.push({ path: "", urls: [], optional: entry.force === false, curseforge: { projectId: entry.projectID!, fileId: entry.fileID! } });
      }
      continue;
    }
    if (entry.type === "addon" && typeof entry.path === "string" && meta.fileApi && /^https:\/\//i.test(meta.fileApi)) {
      let path: string;
      try {
        path = normalizePackPath(entry.path);
      } catch {
        skipped++;
        continue;
      }
      if (seen.has(path.toLowerCase())) continue;
      seen.add(path.toLowerCase());
      const hash = typeof entry.hash === "string" && /^[0-9a-f]{40}$/i.test(entry.hash) ? entry.hash.toLowerCase() : undefined;
      files.push({ path, urls: [joinUrl(meta.fileApi, entry.path)], hashes: hash ? { sha1: hash } : undefined, optional: entry.force === false, label: path.split("/").pop() });
      continue;
    }
    skipped++;
  }
  if (skipped) warnings.push(`有 ${skipped} 个文件条目的类型或地址无法识别，已跳过（如果它们在压缩包的 overrides 里则仍会被复制）`);

  const settings: PackSettings = {};
  if (Number(meta.launchInfo?.minMemory) > 0) settings.memoryMb = Number(meta.launchInfo!.minMemory);

  const name = meta.name.trim();
  return {
    format: "mcbbs",
    name,
    version: typeof meta.version === "string" ? meta.version : undefined,
    author: typeof meta.author === "string" ? meta.author : undefined,
    summary: typeof meta.description === "string" ? meta.description : undefined,
    mcVersion,
    loader: loaders[0],
    files,
    overrides: ["overrides/"],
    warnings,
    settings: Object.keys(settings).length ? settings : undefined,
    origin: { source: ORIGIN_SOURCE.mcbbs, name, version: typeof meta.version === "string" ? meta.version : undefined },
  };
}
