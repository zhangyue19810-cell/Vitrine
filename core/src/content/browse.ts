import { basename, join } from "node:path";
import type { DownloadEngine, DownloadItem, HashSpec, Progress } from "../net/download";
import type { SourceRouter } from "../net/sources";
import { AbortError, isAbort } from "../util/async";
import { CF_CLASS, CF_LOADER, cfHashes, type CfFile, type CfMod, type CurseForgeClient } from "./curseforge";
import { cdnCandidates } from "../pack/cf-pack";
import { hashMods, removeModFile, scanMods, type LocalMod } from "./local-mods";
import { fileHashes, type ModrinthClient, type ModrinthHit, type ModrinthProject, type ModrinthProjectType, type ModrinthVersion } from "./modrinth";

export type ContentSource = "modrinth" | "curseforge";
export type ContentKind = "mod" | "modpack" | "resourcepack" | "shader" | "datapack";

export interface ContentProject {
  source: ContentSource;
  id: string;
  slug?: string;
  kind: ContentKind;
  title: string;
  summary: string;
  author?: string;
  iconUrl?: string;
  downloads: number;
  categories: string[];
  updatedAt?: string;
  pageUrl: string;
  clientSide?: string;
  serverSide?: string;
}

export interface ContentFile {
  name: string;
  url: string;
  size: number;
  hashes: HashSpec;
  primary: boolean;
  /** CurseForge: the author hides the direct link; the CDN path is used instead. */
  restricted?: boolean;
}

export interface ContentDependency {
  source: ContentSource;
  projectId?: string;
  versionId?: string;
  kind: "required" | "optional" | "incompatible" | "embedded";
}

export interface ContentVersion {
  source: ContentSource;
  projectId: string;
  id: string;
  name: string;
  versionNumber: string;
  channel: "release" | "beta" | "alpha";
  gameVersions: string[];
  loaders: string[];
  publishedAt: string;
  downloads: number;
  changelog?: string;
  files: ContentFile[];
  dependencies: ContentDependency[];
}

export interface ContentDeps {
  modrinth: ModrinthClient;
  curseforge: CurseForgeClient;
  router: SourceRouter;
  engine: DownloadEngine;
}

export interface ContentFilter {
  gameVersion?: string;
  /** Loader name as Modrinth spells it: fabric, quilt, forge, neoforge. */
  loader?: string;
}

export interface ContentSearchQuery extends ContentFilter {
  source: ContentSource;
  kind: ContentKind;
  query?: string;
  sort?: "relevance" | "downloads" | "updated" | "newest";
  category?: string;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface ContentSearchResult {
  projects: ContentProject[];
  total: number;
  page: number;
  pageSize: number;
  /** Set when the original words were too narrow and the backend searched a broader related term. */
  effectiveQuery?: string;
  /** True when `effectiveQuery` differs from the query the user typed. */
  relaxed?: boolean;
}

const MR_TYPE: Record<ContentKind, ModrinthProjectType> = { mod: "mod", modpack: "modpack", resourcepack: "resourcepack", shader: "shader", datapack: "datapack" };
const CF_KIND: Record<ContentKind, number> = { mod: CF_CLASS.mod, modpack: CF_CLASS.modpack, resourcepack: CF_CLASS.resourcepack, shader: CF_CLASS.shader, datapack: CF_CLASS.datapack };
const LOADER_AWARE = new Set<ContentKind>(["mod", "modpack"]);

/** Below this many matches, try a related keyword instead of requiring the exact phrase. */
const RELAX_SEARCH_BELOW = 8;

/**
 * Minecraft content is mostly described in English even when the player searches in Chinese.
 * These aliases are deliberately small and category-oriented: they are a search aid, not a translator.
 */
const SEARCH_ALIASES: Record<string, string[]> = {
  "优化": ["optimization", "performance"],
  "性能": ["performance", "optimization"],
  "卡顿": ["performance", "optimization"],
  "帧数": ["fps", "performance"],
  "光影": ["shader", "shaders"],
  "着色器": ["shader", "shaders"],
  "资源包": ["resourcepack", "resource pack"],
  "材质包": ["resourcepack", "resource pack"],
  "数据包": ["datapack", "data pack"],
  "模组": ["mod"],
  "整合包": ["modpack"],
  "科技": ["technology", "tech"],
  "工业": ["industrial", "technology"],
  "机械": ["machinery", "technology"],
  "魔法": ["magic"],
  "冒险": ["adventure"],
  "农业": ["farming"],
  "食物": ["food"],
  "烹饪": ["cooking"],
  "存储": ["storage"],
  "背包": ["backpack", "inventory"],
  "物品": ["items"],
  "方块": ["blocks"],
  "装饰": ["decoration"],
  "建筑": ["building"],
  "家具": ["furniture"],
  "照明": ["lighting"],
  "红石": ["redstone"],
  "能源": ["energy"],
  "物流": ["logistics"],
  "管道": ["pipes"],
  "地图": ["map"],
  "小地图": ["minimap"],
  "传送": ["teleport"],
  "结构": ["structures"],
  "世界生成": ["worldgen", "world generation"],
  "生物群系": ["biomes"],
  "维度": ["dimensions"],
  "下界": ["nether"],
  "末地": ["end"],
  "怪物": ["mobs"],
  "生物": ["mobs"],
  "战斗": ["combat"],
  "武器": ["weapons"],
  "装备": ["equipment"],
  "工具": ["tools"],
  "附魔": ["enchantment"],
  "任务": ["quests"],
  "成就": ["advancements"],
  "经济": ["economy"],
  "商店": ["shop"],
  "交易": ["trading"],
  "服务器": ["server"],
  "插件": ["plugin"],
  "界面": ["gui", "interface"],
  "字体": ["font"],
  "汉化": ["translation", "chinese"],
  "中文": ["chinese"],
  "音乐": ["music"],
  "声音": ["sound", "audio"],
  "天气": ["weather"],
  "季节": ["seasons"],
  "物理": ["physics"],
  "渲染": ["rendering"],
  "区块": ["chunks"],
  "粒子": ["particles"],
  "启动": ["startup"],
  "内存": ["memory"],
  "实用": ["utility"],
  "辅助": ["utility"],
  "前置": ["library", "api"],
};

const SEARCH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "in", "with", "on", "my",
  "mod", "mods", "minecraft", "mc", "java", "edition", "addon", "addons",
  "我的世界", "模组", "版本", "一个", "一些",
]);

/** Common project/category names used only to recover from a small typo when the first search finds nothing. */
const SEARCH_CORRECTIONS = [
  "sodium", "lithium", "iris", "optifine", "embeddium", "rubidium", "indium",
  "create", "jei", "rei", "emi", "journeymap", "minimap", "xaeros", "worldedit",
  "worldguard", "luckperms", "fabric", "forge", "neoforge", "quilt", "architectury",
  "cloth-config", "modmenu", "appleskin", "jade", "wthit", "farmers-delight",
  "terraforged", "biomesoplenty", "twilightforest", "botania", "thermal", "mekanism",
  "immersiveengineering", "appliedenergistics2", "ae2", "refinedstorage",
  "storagedrawers", "sophisticatedbackpacks", "curios", "patchouli", "geckolib",
  "citadel", "ftb", "quests", "createaddition", "crafttweaker", "kubejs", "citadel",
  "performance", "optimization", "technology", "adventure", "magic", "farming",
  "storage", "decoration", "building", "utility", "library", "resourcepack",
  "shader", "shaders", "datapack", "modpack", "server", "client", "worldgen",
];

const hasCjk = (value: string) => /[\u3400-\u9fff]/.test(value);

function cleanSearchText(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}

function searchTokens(value: string): string[] {
  return cleanSearchText(value).toLowerCase().match(/[a-z0-9][a-z0-9._+-]*|[\u3400-\u9fff]+/g) ?? [];
}

function translatedSearch(value: string): { text: string; aliases: string[] } {
  let text = cleanSearchText(value);
  const aliases: string[] = [];
  for (const [term, translated] of Object.entries(SEARCH_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    if (!text.includes(term)) continue;
    aliases.push(...translated);
    text = text.split(term).join(" ");
  }
  return { text: cleanSearchText(text), aliases: [...new Set(aliases)] };
}

/** Bounded Levenshtein distance; enough for small spelling errors without pulling in a search dependency. */
function editDistanceAtMost(left: string, right: string, limit: number): number | undefined {
  if (Math.abs(left.length - right.length) > limit) return undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return undefined;
    previous = current;
  }
  return previous[right.length] <= limit ? previous[right.length] : undefined;
}

function correctedToken(token: string): string | undefined {
  if (token.length < 4 || hasCjk(token)) return undefined;
  const limit = token.length >= 8 ? 2 : 1;
  let best: { word: string; distance: number } | undefined;
  for (const word of SEARCH_CORRECTIONS) {
    if (word === token) continue;
    const distance = editDistanceAtMost(token, word, limit);
    if (distance === undefined) continue;
    if (!best || distance < best.distance || (distance === best.distance && word.length < best.word.length)) best = { word, distance };
  }
  return best?.word;
}

/** Broad interpretations of a query, ordered from most literal to most relaxed. */
export function relaxedSearchQueries(input: string): string[] {
  const raw = cleanSearchText(input);
  if (!raw) return [];
  const { text, aliases } = translatedSearch(raw);
  const tokens = searchTokens(text);
  const meaningful = tokens.filter((token) => !SEARCH_STOPWORDS.has(token) && (token.length > 1 || hasCjk(token)));
  const variants: string[] = [];
  // A translated category is usually the most useful fallback for a Chinese query.
  variants.push(...aliases);
  if (text && text.toLowerCase() !== raw.toLowerCase()) variants.push(text);
  if (meaningful.length > 1) {
    for (const token of [...meaningful].sort((a, b) => b.length - a.length)) variants.push(token);
  }
  for (const token of meaningful) {
    const corrected = correctedToken(token);
    if (corrected) variants.push(corrected);
  }
  const seen = new Set([raw.toLowerCase()]);
  return variants
    .map(cleanSearchText)
    .filter((variant) => {
      const key = variant.toLowerCase();
      if (!variant || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

export const FOLDER_FOR_KIND: Record<Exclude<ContentKind, "modpack">, string> = { mod: "mods", resourcepack: "resourcepacks", shader: "shaderpacks", datapack: "datapacks" };

function kindFromClass(classId: number | undefined, fallback: ContentKind): ContentKind {
  switch (classId) {
    case CF_CLASS.mod:
      return "mod";
    case CF_CLASS.modpack:
      return "modpack";
    case CF_CLASS.resourcepack:
      return "resourcepack";
    case CF_CLASS.shader:
      return "shader";
    case CF_CLASS.datapack:
      return "datapack";
    default:
      return fallback;
  }
}

function fromModrinthHit(hit: ModrinthHit): ContentProject {
  return {
    source: "modrinth",
    id: hit.project_id,
    slug: hit.slug,
    kind: hit.project_type === "plugin" ? "mod" : (hit.project_type as ContentKind),
    title: hit.title,
    summary: hit.description,
    author: hit.author,
    iconUrl: hit.icon_url || undefined,
    downloads: hit.downloads,
    categories: hit.categories ?? [],
    updatedAt: hit.date_modified,
    pageUrl: `https://modrinth.com/${hit.project_type}/${hit.slug}`,
    clientSide: hit.client_side,
    serverSide: hit.server_side,
  };
}

function fromModrinthProject(project: ModrinthProject): ContentProject {
  return {
    source: "modrinth",
    id: project.id,
    slug: project.slug,
    kind: project.project_type === "plugin" ? "mod" : (project.project_type as ContentKind),
    title: project.title,
    summary: project.description,
    iconUrl: project.icon_url || undefined,
    downloads: project.downloads,
    categories: project.categories ?? [],
    pageUrl: `https://modrinth.com/${project.project_type}/${project.slug}`,
    clientSide: project.client_side,
    serverSide: project.server_side,
  };
}

function fromCurseForge(mod: CfMod, kind: ContentKind): ContentProject {
  return {
    source: "curseforge",
    id: String(mod.id),
    slug: mod.slug,
    kind: kindFromClass(mod.classId, kind),
    title: mod.name,
    summary: mod.summary,
    author: mod.authors?.[0]?.name,
    iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || undefined,
    downloads: mod.downloadCount,
    categories: (mod.categories ?? []).map((category) => category.name),
    updatedAt: mod.dateModified,
    pageUrl: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/${mod.slug}`,
  };
}

async function searchContentOnce(deps: ContentDeps, query: ContentSearchQuery, page: number, pageSize: number): Promise<ContentSearchResult> {
  const useLoader = LOADER_AWARE.has(query.kind);
  if (query.source === "modrinth") {
    const index = query.sort === "downloads" ? "downloads" : query.sort === "updated" ? "updated" : query.sort === "newest" ? "newest" : undefined;
    const result = await deps.modrinth.search({
      query: query.query,
      type: MR_TYPE[query.kind],
      gameVersion: query.gameVersion,
      loader: useLoader ? query.loader : undefined,
      categories: query.category ? [query.category] : undefined,
      index,
      offset: page * pageSize,
      limit: pageSize,
      signal: query.signal,
    });
    return { projects: result.hits.map(fromModrinthHit), total: result.total_hits, page, pageSize };
  }
  const sortField = query.sort === "downloads" ? 6 : query.sort === "updated" ? 3 : query.sort === "newest" ? 11 : undefined;
  const result = await deps.curseforge.search({
    query: query.query,
    classId: CF_KIND[query.kind],
    gameVersion: query.gameVersion,
    modLoader: useLoader && query.loader ? CF_LOADER[query.loader as keyof typeof CF_LOADER] : undefined,
    sortField,
    index: page * pageSize,
    pageSize,
    signal: query.signal,
  });
  return { projects: result.data.map((mod) => fromCurseForge(mod, query.kind)), total: result.pagination.totalCount, page, pageSize };
}

export async function searchContent(deps: ContentDeps, query: ContentSearchQuery): Promise<ContentSearchResult> {
  const pageSize = Math.max(1, Math.min(query.pageSize ?? 20, 50));
  const page = Math.max(0, query.page ?? 0);
  const rawQuery = query.query?.trim();
  const first = await searchContentOnce(deps, { ...query, query: rawQuery || undefined }, page, pageSize);

  // Exact full-text search is useful, but players often type a category in Chinese, a short phrase,
  // or one misspelled word. If the first page is thin, try related keywords and use the broader result
  // for the whole result set. Paging then stays consistent because the UI reuses effectiveQuery.
  if (!rawQuery || page !== 0 || first.total >= RELAX_SEARCH_BELOW || first.projects.length >= RELAX_SEARCH_BELOW) return first;
  const alternatives = relaxedSearchQueries(rawQuery);
  if (!alternatives.length) return first;

  let best = first;
  let effectiveQuery: string | undefined;
  for (const alternative of alternatives) {
    let candidate: ContentSearchResult;
    try {
      candidate = await searchContentOnce(deps, { ...query, query: alternative, page: 0 }, 0, pageSize);
    } catch {
      // A failed optional lookup must not hide the primary search that already succeeded.
      continue;
    }
    if (candidate.total > best.total || (candidate.total === best.total && candidate.projects.length > best.projects.length)) {
      best = candidate;
      effectiveQuery = alternative;
    }
    if (best.total >= RELAX_SEARCH_BELOW) break;
  }
  return effectiveQuery ? { ...best, effectiveQuery, relaxed: true } : first;
}

export async function getProject(deps: ContentDeps, source: ContentSource, id: string, signal?: AbortSignal): Promise<ContentProject & { body?: string }> {
  if (source === "modrinth") {
    const project = await deps.modrinth.project(id, signal);
    return { ...fromModrinthProject(project), body: project.body };
  }
  return fromCurseForge(await deps.curseforge.mod(Number(id), signal), "mod");
}

function fromModrinthVersion(version: ModrinthVersion): ContentVersion {
  return {
    source: "modrinth",
    projectId: version.project_id,
    id: version.id,
    name: version.name,
    versionNumber: version.version_number,
    channel: version.version_type,
    gameVersions: version.game_versions,
    loaders: version.loaders,
    publishedAt: version.date_published,
    downloads: version.downloads,
    changelog: version.changelog,
    files: version.files.map((file) => ({ name: file.filename, url: file.url, size: file.size, hashes: fileHashes(file), primary: file.primary })),
    dependencies: version.dependencies
      .filter((dep) => dep.dependency_type !== "embedded" || dep.project_id)
      .map((dep) => ({ source: "modrinth" as const, projectId: dep.project_id ?? undefined, versionId: dep.version_id ?? undefined, kind: dep.dependency_type })),
  };
}

const CF_RELATION: Record<number, ContentDependency["kind"] | undefined> = { 1: "embedded", 2: "optional", 3: "required", 5: "incompatible", 6: "embedded" };

function fromCurseForgeFile(file: CfFile): ContentVersion {
  const loaders = file.gameVersions.map((value) => value.toLowerCase()).filter((value) => ["forge", "fabric", "quilt", "neoforge"].includes(value));
  return {
    source: "curseforge",
    projectId: String(file.modId),
    id: String(file.id),
    name: file.displayName,
    versionNumber: file.displayName,
    channel: file.releaseType === 1 ? "release" : file.releaseType === 2 ? "beta" : "alpha",
    gameVersions: file.gameVersions.filter((value) => /^\d/.test(value)),
    loaders,
    publishedAt: file.fileDate,
    downloads: file.downloadCount ?? 0,
    files: [{ name: file.fileName, url: cdnCandidates(file)[0], size: file.fileLength, hashes: cfHashes(file), primary: true, restricted: !file.downloadUrl }],
    dependencies: (file.dependencies ?? []).flatMap((dep) => {
      const kind = CF_RELATION[dep.relationType];
      return kind ? [{ source: "curseforge" as const, projectId: String(dep.modId), kind }] : [];
    }),
  };
}

/** Versions of a project that fit the instance, newest first. */
export async function listContentVersions(deps: ContentDeps, source: ContentSource, projectId: string, filter: ContentFilter = {}, signal?: AbortSignal): Promise<ContentVersion[]> {
  if (source === "modrinth") {
    const versions = await deps.modrinth.versions(projectId, { loaders: filter.loader ? [filter.loader] : undefined, gameVersions: filter.gameVersion ? [filter.gameVersion] : undefined }, signal);
    return versions.map(fromModrinthVersion);
  }
  const files = await deps.curseforge.files(Number(projectId), { gameVersion: filter.gameVersion, modLoader: filter.loader ? CF_LOADER[filter.loader as keyof typeof CF_LOADER] : undefined, pageSize: 50 }, signal);
  return files.filter((file) => file.isAvailable !== false).map(fromCurseForgeFile).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** The version to install by default: newest release, else newest beta, else whatever exists. */
export function bestVersion(versions: ContentVersion[]): ContentVersion | undefined {
  return versions.find((version) => version.channel === "release") ?? versions.find((version) => version.channel === "beta") ?? versions[0];
}

// ---------------------------------------------------------------------------------------------- install

export interface InstallContentRequest {
  gameDir: string;
  kind: Exclude<ContentKind, "modpack">;
  source: ContentSource;
  projectId: string;
  /** A specific version; the best compatible one when omitted. */
  versionId?: string;
  filter: ContentFilter;
  /** Required dependencies are installed too (default true; mods only). */
  withDependencies?: boolean;
  /** For data packs: the save folder to install into. */
  world?: string;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  /** Called before each file is downloaded, with what is about to be installed. */
  onPlan?: (plan: { title: string; version: string; file: string; dependency: boolean }[]) => void;
}

export interface InstalledContent {
  title: string;
  version: string;
  path: string;
  dependency: boolean;
  projectId: string;
}

export interface InstallContentResult {
  installed: InstalledContent[];
  skipped: { title: string; reason: string }[];
  failed: { title: string; error: string; pageUrl?: string }[];
}

function targetFolder(request: InstallContentRequest): string {
  if (request.kind === "datapack") {
    if (!request.world || /[\\/]|\.\./.test(request.world)) throw new Error("安装数据包需要先选择一个存档");
    return `saves/${request.world}/datapacks`;
  }
  return FOLDER_FOR_KIND[request.kind];
}

/** Which Modrinth projects (or CurseForge slugs) are already in the mods folder? */
async function installedIdentity(deps: ContentDeps, gameDir: string, folder: string, signal?: AbortSignal): Promise<{ projects: Set<string>; modIds: Set<string>; files: Set<string> }> {
  const mods = await scanMods(gameDir, { folder, signal }).catch(() => [] as LocalMod[]);
  const projects = new Set<string>();
  const modIds = new Set<string>();
  const files = new Set(mods.map((mod) => mod.file.replace(/\.(disabled|old)$/i, "").toLowerCase()));
  for (const mod of mods) {
    if (mod.disabled) continue;
    if (mod.meta?.id) modIds.add(mod.meta.id.toLowerCase());
    for (const id of mod.meta?.provides ?? []) modIds.add(id.toLowerCase());
  }
  if (mods.length) {
    try {
      const hashed = await hashMods(gameDir, mods.filter((mod) => !mod.disabled), { folder, signal });
      const found = await deps.modrinth.versionsByHashes(hashed.flatMap((mod) => (mod.sha1 ? [mod.sha1] : [])), "sha1", signal);
      for (const version of Object.values(found)) projects.add(version.project_id);
    } catch (error) {
      if (isAbort(error)) throw error;
      /* identification is best effort; ids and file names still catch most duplicates */
    }
  }
  return { projects, modIds, files };
}

interface Planned {
  version: ContentVersion;
  title: string;
  dependency: boolean;
  pageUrl?: string;
}

/**
 * Install a mod, resource pack, shader pack or data pack and, for mods, the required dependencies that are not
 * already present (recognised by file hash, mod id or file name).
 */
export async function installContent(deps: ContentDeps, request: InstallContentRequest): Promise<InstallContentResult> {
  const folder = targetFolder(request);
  const result: InstallContentResult = { installed: [], skipped: [], failed: [] };
  const filter = request.filter;

  const pickVersion = async (source: ContentSource, projectId: string, versionId?: string): Promise<ContentVersion | undefined> => {
    if (versionId) {
      if (source === "modrinth") return fromModrinthVersion(await deps.modrinth.version(versionId, request.signal));
      const file = await deps.curseforge.file(Number(projectId), Number(versionId), request.signal);
      return fromCurseForgeFile(file);
    }
    return bestVersion(await listContentVersions(deps, source, projectId, request.kind === "mod" ? filter : { gameVersion: filter.gameVersion }, request.signal));
  };

  const infoCache = new Map<string, { title: string; pageUrl?: string }>();
  const infoOf = async (source: ContentSource, projectId: string): Promise<{ title: string; pageUrl?: string }> => {
    const key = `${source}:${projectId}`;
    const cached = infoCache.get(key);
    if (cached) return cached;
    let info: { title: string; pageUrl?: string } = { title: projectId };
    try {
      const project = await getProject(deps, source, projectId, request.signal);
      info = { title: project.title, pageUrl: project.pageUrl };
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    infoCache.set(key, info);
    return info;
  };
  const titleOf = async (source: ContentSource, projectId: string): Promise<string> => (await infoOf(source, projectId)).title;

  const root = await pickVersion(request.source, request.projectId, request.versionId);
  if (!root) throw new Error("没有找到适合当前游戏版本和加载器的版本");
  const identity = request.kind === "mod" ? await installedIdentity(deps, request.gameDir, folder, request.signal) : undefined;

  const rootInfo = await infoOf(request.source, request.projectId);
  const plan: Planned[] = [{ version: root, title: rootInfo.title, dependency: false, pageUrl: rootInfo.pageUrl }];
  const seen = new Set<string>([`${request.source}:${request.projectId}`]);
  if (request.kind === "mod" && request.withDependencies !== false) {
    const queue: ContentVersion[] = [root];
    for (let depth = 0; queue.length && depth < 5; depth++) {
      const next: ContentVersion[] = [];
      for (const current of queue) {
        for (const dep of current.dependencies) {
          if (dep.kind !== "required") continue;
          let projectId = dep.projectId;
          let version: ContentVersion | undefined;
          try {
            if (dep.versionId && dep.source === "modrinth") {
              version = fromModrinthVersion(await deps.modrinth.version(dep.versionId, request.signal));
              projectId = version.projectId;
            }
            if (!projectId) continue;
            const key = `${dep.source}:${projectId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (identity?.projects.has(projectId)) {
              result.skipped.push({ title: await titleOf(dep.source, projectId), reason: "已安装" });
              continue;
            }
            version ??= await pickVersion(dep.source, projectId);
            if (!version) {
              result.failed.push({ title: await titleOf(dep.source, projectId), error: "没有找到适合当前版本的前置模组" });
              continue;
            }
            const title = await titleOf(dep.source, projectId);
            const fileName = (version.files.find((file) => file.primary) ?? version.files[0])?.name.toLowerCase().replace(/\.(disabled|old)$/i, "");
            if ((fileName && identity?.files.has(fileName)) || (dep.source === "curseforge" && identity?.modIds.has(title.toLowerCase()))) {
              result.skipped.push({ title, reason: "已安装" });
              continue;
            }
            plan.push({ version, title, dependency: true, pageUrl: (await infoOf(dep.source, projectId)).pageUrl });
            next.push(version);
          } catch (error) {
            if (isAbort(error)) throw error;
            result.failed.push({ title: projectId ?? "未知前置", error: (error as Error).message });
          }
        }
      }
      queue.splice(0, queue.length, ...next);
    }
  }

  const items: DownloadItem[] = [];
  const meta = new Map<string, Planned & { file: ContentFile }>();
  for (const entry of plan) {
    const file = entry.version.files.find((candidate) => candidate.primary) ?? entry.version.files[0];
    if (!file) {
      result.failed.push({ title: entry.title, error: "这个版本没有可下载的文件" });
      continue;
    }
    const safeName = basename(file.name.replace(/\\/g, "/"));
    if (!safeName || safeName.startsWith(".") || /[<>:"|?*\u0000-\u001f]/.test(safeName)) {
      result.failed.push({ title: entry.title, error: `文件名不安全：${file.name}` });
      continue;
    }
    const dest = join(request.gameDir, folder, safeName);
    const urls = entry.version.source === "curseforge" ? cdnCandidates({ id: Number(entry.version.id), fileName: file.name, downloadUrl: file.restricted ? null : file.url }).flatMap((url) => deps.router.any(url)) : deps.router.contentCandidates(file.url);
    items.push({ urls: [...new Set(urls)], dest, size: file.size > 0 ? file.size : undefined, hash: file.hashes, label: entry.title });
    meta.set(dest, { ...entry, file });
  }
  request.onPlan?.([...meta.values()].map((entry) => ({ title: entry.title, version: entry.version.versionNumber, file: entry.file.name, dependency: entry.dependency })));

  const run = await deps.engine.run(items, { signal: request.signal, onProgress: request.onProgress });
  if (run.cancelled) throw new AbortError();
  for (const item of items) {
    const entry = meta.get(item.dest)!;
    const failure = run.failed.find((candidate) => candidate.item.dest === item.dest);
    if (failure) {
      result.failed.push({ title: entry.title, error: failure.error, pageUrl: entry.file.restricted ? entry.pageUrl : undefined });
      continue;
    }
    result.installed.push({ title: entry.title, version: entry.version.versionNumber, path: `${folder}/${basename(item.dest)}`, dependency: entry.dependency, projectId: entry.version.projectId });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------- updates

export interface ModUpdate {
  file: string;
  path: string;
  projectId: string;
  title: string;
  currentVersion?: string;
  latest: ContentVersion;
}

/**
 * Ask Modrinth which of the installed mods have a newer compatible version. Files are recognised by hash, so
 * mods that did not come from Modrinth (or that were renamed) are still found when Modrinth hosts them.
 */
export async function checkModUpdates(
  deps: ContentDeps,
  gameDir: string,
  filter: { loaders: string[]; gameVersions: string[] },
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ updates: ModUpdate[]; checked: number; unknown: number }> {
  const scanned = await scanMods(gameDir, { signal: options.signal });
  const mods = await hashMods(gameDir, scanned.filter((mod) => !mod.disabled), { signal: options.signal });
  const hashes = mods.flatMap((mod) => (mod.sha1 ? [mod.sha1] : []));
  const current = await deps.modrinth.versionsByHashes(hashes, "sha1", options.signal);
  const latest = await deps.modrinth.latestForHashes(Object.keys(current), filter, "sha1", options.signal);
  const titles = new Map<string, string>();
  const newest = Object.entries(latest).filter(([hash, version]) => !version.files.some((file) => file.hashes.sha1?.toLowerCase() === hash.toLowerCase()) && version.id !== current[hash]?.id);
  if (newest.length) {
    for (const project of await deps.modrinth.projects([...new Set(newest.map(([, version]) => version.project_id))], options.signal).catch(() => [])) titles.set(project.id, project.title);
  }
  const byHash = new Map(mods.flatMap((mod) => (mod.sha1 ? [[mod.sha1.toLowerCase(), mod] as const] : [])));
  const updates: ModUpdate[] = [];
  for (const [hash, version] of newest) {
    const mod = byHash.get(hash.toLowerCase());
    if (!mod) continue;
    updates.push({ file: mod.file, path: mod.path, projectId: version.project_id, title: titles.get(version.project_id) ?? mod.meta?.name ?? mod.file, currentVersion: current[hash]?.version_number ?? mod.meta?.version, latest: fromModrinthVersion(version) });
  }
  return { updates: updates.sort((a, b) => a.title.localeCompare(b.title)), checked: mods.length, unknown: mods.length - Object.keys(current).length };
}

/** Download the newer version next to the old one, then remove the old file. */
export async function applyModUpdate(deps: ContentDeps, gameDir: string, update: ModUpdate, options: { signal?: AbortSignal; onProgress?: (progress: Progress) => void } = {}): Promise<{ path: string }> {
  const file = update.latest.files.find((candidate) => candidate.primary) ?? update.latest.files[0];
  if (!file) throw new Error("新版本没有文件");
  const name = basename(file.name.replace(/\\/g, "/"));
  const dest = join(gameDir, "mods", name);
  const run = await deps.engine.run([{ urls: deps.router.contentCandidates(file.url), dest, size: file.size || undefined, hash: file.hashes, label: update.title }], { signal: options.signal, onProgress: options.onProgress });
  if (run.cancelled) throw new AbortError();
  if (!run.ok) throw new Error(`下载失败：${run.failed[0]?.error ?? "未知错误"}`);
  if (update.file !== name) {
    await removeModFile(gameDir, update.path).catch(() => {});
  }
  return { path: `mods/${name}` };
}
