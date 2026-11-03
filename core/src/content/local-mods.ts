import { readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { mapLimit, throwIfAborted } from "../util/async";
import { ensureDir, exists, hashFile, readJsonOr, writeJsonAtomic } from "../util/fsx";
import { ZipReader } from "../util/zip";

export type ModLoaderType = "fabric" | "quilt" | "forge" | "neoforge" | "legacy-forge" | "liteloader";

export interface ModDependency {
  id: string;
  version?: string;
  kind: "required" | "optional" | "recommended" | "incompatible";
}

export interface ModMeta {
  loaders: ModLoaderType[];
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  authors: string[];
  homepage?: string;
  dependencies: ModDependency[];
  /** Other ids this file satisfies (Fabric `provides`, jars nested inside, extra `[[mods]]` entries). */
  provides: string[];
  environment?: "client" | "server" | "*";
  /** Further mods packed into the same jar. */
  extra: { id: string; name?: string; version?: string }[];
}

export interface LocalMod {
  /** File name on disk, including a `.disabled` suffix when switched off. */
  file: string;
  /** Path relative to the game directory. */
  path: string;
  disabled: boolean;
  size: number;
  mtime: number;
  sha1?: string;
  meta?: ModMeta;
  /** Why the metadata could not be read (the mod may still work). */
  error?: string;
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);
const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

function names(value: unknown): string[] {
  return asArray(value)
    .map((entry) => (typeof entry === "string" ? entry : asString(asObject(entry)?.name)))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.trim());
}

function versionText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(" || ");
  return undefined;
}

/** Fabric / Quilt style `{ "modid": "range" }` dependency maps. */
function mapDeps(value: unknown, kind: ModDependency["kind"]): ModDependency[] {
  const object = asObject(value);
  if (!object) return [];
  return Object.entries(object).map(([id, range]) => ({ id, version: versionText(range), kind }));
}

export const FABRIC_BUILTIN = new Set(["minecraft", "java", "fabricloader", "fabric-loader", "quilt_loader", "quilt-loader", "forge", "neoforge", "javafml", "lowcodefml", "mod_loading"]);

export function parseFabricMod(raw: unknown): ModMeta {
  const json = asObject(raw);
  if (!json) throw new Error("fabric.mod.json is not an object");
  const contact = asObject(json.contact);
  const environment = asString(json.environment);
  return {
    loaders: ["fabric"],
    id: asString(json.id),
    name: asString(json.name) ?? asString(json.id),
    version: asString(json.version),
    description: asString(json.description),
    authors: names(json.authors),
    homepage: asString(contact?.homepage) ?? asString(contact?.sources),
    dependencies: [
      ...mapDeps(json.depends, "required"),
      ...mapDeps(json.recommends, "recommended"),
      ...mapDeps(json.suggests, "optional"),
      ...mapDeps(json.breaks, "incompatible"),
    ],
    provides: asArray(json.provides).map(asString).filter((id): id is string => Boolean(id)),
    environment: environment === "client" || environment === "server" || environment === "*" ? environment : undefined,
    extra: [],
  };
}

export function parseQuiltMod(raw: unknown): ModMeta {
  const root = asObject(raw);
  const loader = asObject(root?.quilt_loader);
  if (!loader) throw new Error("quilt.mod.json has no quilt_loader section");
  const metadata = asObject(loader.metadata);
  const contributors = asObject(metadata?.contributors);
  const deps: ModDependency[] = [];
  for (const entry of asArray(loader.depends)) {
    const object = asObject(entry);
    const id = typeof entry === "string" ? entry : asString(object?.id);
    if (!id) continue;
    deps.push({ id, version: versionText(object?.versions), kind: object?.optional === true ? "optional" : "required" });
  }
  for (const entry of asArray(loader.breaks)) {
    const object = asObject(entry);
    const id = typeof entry === "string" ? entry : asString(object?.id);
    if (id) deps.push({ id, version: versionText(object?.versions), kind: "incompatible" });
  }
  const provides = asArray(loader.provides)
    .map((entry) => (typeof entry === "string" ? entry : asString(asObject(entry)?.id)))
    .filter((id): id is string => Boolean(id));
  const contact = asObject(metadata?.contact);
  return {
    loaders: ["quilt"],
    id: asString(loader.id),
    name: asString(metadata?.name) ?? asString(loader.id),
    version: asString(loader.version),
    description: asString(metadata?.description),
    authors: contributors ? Object.keys(contributors) : [],
    homepage: asString(contact?.homepage),
    dependencies: deps,
    provides,
    extra: [],
  };
}

/** `mods.toml` (Forge) and `neoforge.mods.toml`. A jar can declare several `[[mods]]`; the first is the primary. */
export function parseModsToml(text: string, options: { jarVersion?: string; neoforgeFile?: boolean } = {}): ModMeta[] {
  const root = parseToml(text) as Json;
  const mods = asArray(root.mods).map(asObject).filter((entry): entry is Json => Boolean(entry));
  if (!mods.length) throw new Error("mods.toml declares no [[mods]]");
  const dependencies = asObject(root.dependencies) ?? {};
  const fix = (value: string | undefined) => value?.replace(/\$\{file\.jarVersion\}/g, options.jarVersion ?? "unknown");
  const usesNeoForge = options.neoforgeFile || Object.values(dependencies).flat().some((entry) => asString(asObject(entry)?.modId) === "neoforge");
  const usesForgeOnly = Object.values(dependencies).flat().some((entry) => asString(asObject(entry)?.modId) === "forge");
  const loader: ModLoaderType = options.neoforgeFile || (usesNeoForge && !usesForgeOnly) ? "neoforge" : "forge";
  return mods.map((mod) => {
    const id = asString(mod.modId);
    const deps: ModDependency[] = [];
    for (const entry of asArray(id ? dependencies[id] : undefined)) {
      const dep = asObject(entry);
      const depId = asString(dep?.modId);
      if (!depId) continue;
      // Forge: mandatory = true/false. NeoForge 20.5+: type = "required" | "optional" | "incompatible" | "discouraged".
      const type = asString(dep?.type);
      const kind: ModDependency["kind"] = type === "incompatible" ? "incompatible" : type === "optional" || type === "discouraged" || dep?.mandatory === false ? "optional" : "required";
      deps.push({ id: depId, version: asString(dep?.versionRange), kind });
    }
    return {
      loaders: [loader],
      id,
      name: asString(mod.displayName) ?? id,
      version: fix(asString(mod.version)),
      description: asString(mod.description),
      authors: names(mod.authors),
      homepage: asString(mod.displayURL),
      dependencies: deps,
      provides: [],
      extra: [],
    };
  });
}

/** Make sloppy JSON parseable: raw line breaks inside strings and trailing commas (common in old mcmod.info files). */
export function relaxJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === "\n" || ch === "\r" || ch === "\t") {
        out += " ";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(relaxJson(text));
  }
}

export function parseMcmodInfo(text: string): ModMeta[] {
  const parsed = parseLooseJson(text);
  const list = Array.isArray(parsed) ? parsed : asArray(asObject(parsed)?.modList);
  const out: ModMeta[] = [];
  for (const entry of list) {
    const mod = asObject(entry);
    const id = asString(mod?.modid) ?? asString(mod?.modId);
    if (!mod || !id) continue;
    const deps = [...asArray(mod.dependencies), ...asArray(mod.requiredMods)].map(asString).filter((dep): dep is string => Boolean(dep));
    out.push({
      loaders: ["legacy-forge"],
      id,
      name: asString(mod.name) ?? id,
      version: asString(mod.version),
      description: asString(mod.description),
      authors: names(mod.authorList ?? mod.authors),
      homepage: asString(mod.url),
      dependencies: deps.map((dep) => ({ id: dep, kind: "required" as const })),
      provides: [],
      extra: [],
    });
  }
  if (!out.length) throw new Error("mcmod.info lists no mods");
  return out;
}

export function parseLiteMod(raw: unknown): ModMeta {
  const json = asObject(raw);
  const id = asString(json?.name);
  if (!json || !id) throw new Error("litemod.json has no name");
  return { loaders: ["liteloader"], id, name: id, version: asString(json.version), description: asString(json.description), authors: names(json.author), dependencies: [], provides: [], extra: [] };
}

async function implementationVersion(zip: ZipReader): Promise<string | undefined> {
  if (!zip.has("META-INF/MANIFEST.MF")) return undefined;
  const text = await zip.readText("META-INF/MANIFEST.MF");
  return /^Implementation-Version:\s*(.+?)\s*$/m.exec(text.replace(/\r?\n /g, ""))?.[1];
}

const MAX_NESTED = 48;
const MAX_NESTED_BYTES = 48 * 1024 * 1024;

/** Ids of the mods bundled inside a Fabric jar (`jars`), e.g. the modules inside Fabric API. */
async function nestedFabricIds(zip: ZipReader, paths: string[], depth: number): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths.slice(0, MAX_NESTED)) {
    const entry = zip.get(path);
    if (!entry || entry.size > MAX_NESTED_BYTES) continue;
    try {
      const inner = await ZipReader.fromBuffer(await zip.read(entry, MAX_NESTED_BYTES));
      try {
        if (!inner.has("fabric.mod.json")) continue;
        const raw = asObject(await inner.readJson("fabric.mod.json"));
        const id = asString(raw?.id);
        if (id) ids.push(id);
        ids.push(...asArray(raw?.provides).map(asString).filter((value): value is string => Boolean(value)));
        const deeper = asArray(raw?.jars).map((jar) => asString(asObject(jar)?.file)).filter((value): value is string => Boolean(value));
        if (deeper.length && depth < 2) ids.push(...(await nestedFabricIds(inner, deeper, depth + 1)));
      } finally {
        inner.close();
      }
    } catch {
      /* a damaged nested jar only costs us its id */
    }
  }
  return ids;
}

/**
 * Read the metadata of a mod file. When a jar carries several loaders' descriptors (multi-loader mods),
 * `prefer` decides which one becomes the primary entry.
 */
export async function readModFile(path: string, prefer?: ModLoaderType): Promise<ModMeta> {
  const zip = await ZipReader.open(path);
  try {
    const found: ModMeta[] = [];
    const errors: string[] = [];
    const attempt = async (label: string, work: () => Promise<ModMeta[]>) => {
      try {
        found.push(...(await work()));
      } catch (error) {
        errors.push(`${label}: ${(error as Error).message}`);
      }
    };
    if (zip.has("fabric.mod.json")) {
      await attempt("fabric.mod.json", async () => {
        const raw = await zip.readJson("fabric.mod.json");
        const meta = parseFabricMod(raw);
        const jars = asArray(asObject(raw)?.jars).map((jar) => asString(asObject(jar)?.file)).filter((value): value is string => Boolean(value));
        if (jars.length) meta.provides.push(...(await nestedFabricIds(zip, jars, 0)));
        return [meta];
      });
    }
    if (zip.has("quilt.mod.json")) await attempt("quilt.mod.json", async () => [parseQuiltMod(await zip.readJson("quilt.mod.json"))]);
    const neo = zip.has("META-INF/neoforge.mods.toml");
    const tomlName = neo ? "META-INF/neoforge.mods.toml" : zip.has("META-INF/mods.toml") ? "META-INF/mods.toml" : undefined;
    if (tomlName) await attempt(tomlName, async () => parseModsToml(await zip.readText(tomlName), { jarVersion: await implementationVersion(zip), neoforgeFile: neo }));
    if (!tomlName && zip.has("mcmod.info")) await attempt("mcmod.info", async () => parseMcmodInfo(await zip.readText("mcmod.info")));
    if (zip.has("litemod.json")) await attempt("litemod.json", async () => [parseLiteMod(await zip.readJson("litemod.json"))]);

    if (!found.length) throw new Error(errors[0] ?? "没有找到模组描述文件");
    const primary = (prefer && found.find((meta) => meta.loaders.includes(prefer))) || found[0];
    const rest = found.filter((meta) => meta !== primary);
    const loaders = [...new Set(found.flatMap((meta) => meta.loaders))];
    const sameFile = (meta: ModMeta) => (meta.id && meta.id !== primary.id ? [{ id: meta.id, name: meta.name, version: meta.version }] : []);
    return {
      ...primary,
      loaders,
      extra: [...primary.extra, ...rest.flatMap(sameFile)],
      provides: [...new Set([...primary.provides, ...rest.flatMap((meta) => (meta.id && meta.id !== primary.id ? [meta.id] : [])), ...rest.flatMap((meta) => meta.provides)])],
    };
  } finally {
    zip.close();
  }
}

const ICON_LIMIT = 512 * 1024;

/** The mod's icon as a data URL (Fabric `icon`, Quilt `metadata.icon`, Forge `logoFile`, legacy `logoFile`). */
export async function readModIcon(path: string): Promise<string | undefined> {
  const zip = await ZipReader.open(path);
  try {
    const candidates: string[] = [];
    if (zip.has("fabric.mod.json")) {
      const icon = asObject(await zip.readJson("fabric.mod.json").catch(() => undefined))?.icon;
      if (typeof icon === "string") candidates.push(icon);
      else {
        const sizes = asObject(icon);
        if (sizes) candidates.push(...Object.entries(sizes).sort((a, b) => Number(b[0]) - Number(a[0])).map(([, value]) => String(value)));
      }
    }
    if (zip.has("quilt.mod.json")) {
      const icon = asObject(asObject(asObject(await zip.readJson("quilt.mod.json").catch(() => undefined))?.quilt_loader)?.metadata)?.icon;
      if (typeof icon === "string") candidates.push(icon);
    }
    for (const toml of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
      if (!zip.has(toml)) continue;
      try {
        const mods = asArray((parseToml(await zip.readText(toml)) as Json).mods);
        const logo = asString(asObject(mods[0])?.logoFile);
        if (logo) candidates.push(logo);
      } catch {
        /* ignore */
      }
    }
    if (zip.has("mcmod.info")) {
      try {
        const list = parseMcmodInfoRaw(await zip.readText("mcmod.info"));
        const logo = asString(asObject(list[0])?.logoFile);
        if (logo) candidates.push(logo);
      } catch {
        /* ignore */
      }
    }
    candidates.push("icon.png", "logo.png", "pack.png");
    for (const candidate of candidates) {
      const entry = zip.get(candidate.replace(/^\/+/, ""));
      if (!entry || entry.size > ICON_LIMIT || !/\.(png|jpe?g)$/i.test(entry.name)) continue;
      const data = await zip.read(entry, ICON_LIMIT);
      return `data:image/${/\.png$/i.test(entry.name) ? "png" : "jpeg"};base64,${data.toString("base64")}`;
    }
    return undefined;
  } finally {
    zip.close();
  }
}

function parseMcmodInfoRaw(text: string): unknown[] {
  const parsed = parseLooseJson(text);
  return Array.isArray(parsed) ? parsed : asArray(asObject(parsed)?.modList);
}

// ---------------------------------------------------------------------------------------------- scanning

const MOD_FILE = /\.(jar|zip|litemod)(\.disabled|\.old)?$/i;

interface CacheEntry {
  size: number;
  mtime: number;
  sha1?: string;
  meta?: ModMeta;
  error?: string;
  prefer?: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface ScanOptions {
  /** Sub-folder of the game directory; "mods" by default. */
  folder?: string;
  prefer?: ModLoaderType;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

const cachePath = (gameDir: string, folder: string) => join(gameDir, ".vitrine", `${folder.replace(/[^a-z0-9]/gi, "_")}-cache.json`);

/** List mod files with their metadata. Parsed metadata is cached by (size, mtime) so rescans of 300 mods are instant. */
export async function scanMods(gameDir: string, options: ScanOptions = {}): Promise<LocalMod[]> {
  const folder = options.folder ?? "mods";
  const dir = join(gameDir, folder);
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = dirents.filter((entry) => entry.isFile() && MOD_FILE.test(entry.name)).map((entry) => entry.name);
  const cache = await readJsonOr<CacheFile>(cachePath(gameDir, folder), { version: 1, entries: {} });
  const entries = cache.version === 1 ? cache.entries : {};
  const next: Record<string, CacheEntry> = {};
  let done = 0;
  const mods = await mapLimit(
    files,
    options.concurrency ?? 8,
    async (file): Promise<LocalMod> => {
      const full = join(dir, file);
      const info = await stat(full);
      const base = { file, path: `${folder}/${file}`, disabled: /\.(disabled|old)$/i.test(file), size: info.size, mtime: Math.round(info.mtimeMs) };
      let cached = entries[file];
      if (!cached || cached.size !== info.size || cached.mtime !== base.mtime || cached.prefer !== (options.prefer ?? "")) {
        cached = { size: info.size, mtime: base.mtime, prefer: options.prefer ?? "", sha1: undefined };
        try {
          cached.meta = await readModFile(full, options.prefer);
        } catch (error) {
          cached.error = (error as Error).message;
        }
      }
      next[file] = cached;
      options.onProgress?.(++done, files.length);
      return { ...base, sha1: cached.sha1, meta: cached.meta, error: cached.error };
    },
    options.signal,
  );
  throwIfAborted(options.signal);
  if (JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(entries).sort()) || files.some((file) => entries[file] !== next[file])) {
    await ensureDir(join(gameDir, ".vitrine"));
    await writeJsonAtomic(cachePath(gameDir, folder), { version: 1, entries: next } satisfies CacheFile, false).catch(() => {});
  }
  return mods.sort((a, b) => (a.meta?.name ?? a.file).toLowerCase().localeCompare((b.meta?.name ?? b.file).toLowerCase()));
}

/** Compute (and cache) SHA-1 for every mod: needed to look them up on Modrinth. */
export async function hashMods(gameDir: string, mods: LocalMod[], options: { folder?: string; signal?: AbortSignal; concurrency?: number } = {}): Promise<LocalMod[]> {
  const folder = options.folder ?? "mods";
  const cache = await readJsonOr<CacheFile>(cachePath(gameDir, folder), { version: 1, entries: {} });
  let changed = false;
  const out = await mapLimit(
    mods,
    options.concurrency ?? 4,
    async (mod) => {
      if (mod.sha1) return mod;
      const sha1 = await hashFile(join(gameDir, mod.path), "sha1");
      const entry = cache.entries[mod.file];
      if (entry && entry.size === mod.size && entry.mtime === mod.mtime) {
        entry.sha1 = sha1;
        changed = true;
      }
      return { ...mod, sha1 };
    },
    options.signal,
  );
  if (changed) await writeJsonAtomic(cachePath(gameDir, folder), cache, false).catch(() => {});
  return out;
}

/** Switch a mod on or off by renaming it to / from `<file>.disabled`. Returns the new relative path. */
export async function setModEnabled(gameDir: string, relativePath: string, enabled: boolean): Promise<string> {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith("/")) throw new Error("路径不安全");
  const from = join(gameDir, normalized);
  if (!(await exists(from))) throw new Error("文件不存在");
  const isDisabled = /\.(disabled|old)$/i.test(normalized);
  if (enabled === !isDisabled) return normalized;
  const target = enabled ? normalized.replace(/\.(disabled|old)$/i, "") : `${normalized}.disabled`;
  if (await exists(join(gameDir, target))) throw new Error(`已经存在同名文件：${target.split("/").pop()}`);
  await rename(from, join(gameDir, target));
  return target;
}

export async function removeModFile(gameDir: string, relativePath: string): Promise<void> {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith("/") || !MOD_FILE.test(normalized)) throw new Error("只能删除模组文件");
  await unlink(join(gameDir, normalized));
}

// ---------------------------------------------------------------------------------------------- checks

export interface ModProblem {
  kind: "duplicate" | "missing-dependency" | "incompatible";
  /** Files involved. */
  files: string[];
  id: string;
  message: string;
}

/** Cheap structural checks across enabled mods: duplicates, missing required dependencies, declared conflicts. */
export function analyzeMods(mods: LocalMod[]): ModProblem[] {
  const enabled = mods.filter((mod) => !mod.disabled && mod.meta);
  const providers = new Map<string, LocalMod[]>();
  const add = (id: string | undefined, mod: LocalMod) => {
    if (!id) return;
    const list = providers.get(id) ?? [];
    if (!list.includes(mod)) list.push(mod);
    providers.set(id, list);
  };
  for (const mod of enabled) {
    add(mod.meta!.id, mod);
    for (const extra of mod.meta!.extra) add(extra.id, mod);
    for (const id of mod.meta!.provides) add(id, mod);
  }
  const problems: ModProblem[] = [];
  // Two files with the same primary id, which Fabric / Forge refuse to load.
  const primary = new Map<string, LocalMod[]>();
  for (const mod of enabled) {
    const id = mod.meta!.id;
    if (!id) continue;
    primary.set(id, [...(primary.get(id) ?? []), mod]);
  }
  for (const [id, list] of primary) {
    if (list.length > 1) problems.push({ kind: "duplicate", id, files: list.map((mod) => mod.file), message: `模组 “${list[0].meta!.name ?? id}” 装了 ${list.length} 个文件：${list.map((mod) => mod.file).join("、")}。请只保留一个。` });
  }
  for (const mod of enabled) {
    for (const dep of mod.meta!.dependencies) {
      if (FABRIC_BUILTIN.has(dep.id)) continue;
      if (dep.kind === "required" && !providers.has(dep.id)) {
        problems.push({ kind: "missing-dependency", id: dep.id, files: [mod.file], message: `“${mod.meta!.name ?? mod.file}” 需要前置模组 ${dep.id}${dep.version && dep.version !== "*" ? `（${dep.version}）` : ""}，但没有找到。` });
      } else if (dep.kind === "incompatible" && providers.has(dep.id)) {
        const other = providers.get(dep.id)!.filter((candidate) => candidate !== mod);
        if (other.length) problems.push({ kind: "incompatible", id: dep.id, files: [mod.file, ...other.map((candidate) => candidate.file)], message: `“${mod.meta!.name ?? mod.file}” 声明与 ${other[0].meta!.name ?? dep.id} 不兼容。` });
      }
    }
  }
  return problems;
}
