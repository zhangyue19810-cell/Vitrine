import { readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyDir, ensureDir, exists, readJson, readJsonOr, removeRecursive, writeJsonAtomic } from "../util/fsx";
import { fallbackJavaMajor } from "../util/version";
import { defaultRuleContext } from "./rules";
import type { LoaderKind } from "./types";
import {
  MissingVersionError,
  detectLoaders,
  detectMinecraftVersion,
  requiredJavaMajor,
  resolveVersion,
  versionDir,
  versionJarPath,
  versionJsonPath,
  versionsDir,
  type LoaderInfo,
} from "./version-json";

export type IsolationMode = "auto" | "on" | "off";

export interface ModpackOrigin {
  source: "modrinth" | "curseforge" | "mrpack" | "curseforge-zip" | "multimc" | "mcbbs" | "vitrine";
  name?: string;
  version?: string;
  projectId?: string;
  versionId?: string;
  iconUrl?: string;
}

/** Per-instance settings, stored next to the version JSON as `vitrine.json`. */
export interface InstanceConfig {
  displayName?: string;
  note?: string;
  /** Built-in cassette tint id or a data/file URL of a custom icon. */
  icon?: string;
  group?: string;
  favorite?: boolean;
  isolation: IsolationMode;
  javaPath?: string;
  /** "auto" picks from the machine and the modpack size; a number is a fixed heap in MB. */
  memory?: "auto" | number;
  jvmPreset?: "default" | "mojang" | "large-modpack" | "zgc";
  jvmArgs?: string;
  gameArgs?: string;
  width?: number;
  height?: number;
  fullscreen?: boolean;
  /** Account id override; otherwise the globally selected account is used. */
  accountId?: string;
  /** Join this server automatically after start. */
  autoJoin?: string;
  preLaunch?: string;
  wrapper?: string;
  env?: Record<string, string>;
  lastPlayed?: number;
  playTimeMs?: number;
  createdAt?: number;
  modpack?: ModpackOrigin;
  /** Installed through Vitrine: loader info recorded at install time (the version JSON stays authoritative). */
  installed?: { mcVersion: string; loader?: { kind: LoaderKind; version: string } };
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = { isolation: "on" };

export type ReleaseKind = "release" | "snapshot" | "old_beta" | "old_alpha" | "unknown";

export interface InstanceInfo {
  id: string;
  name: string;
  dir: string;
  gameDir: string;
  isolated: boolean;
  mcVersion?: string;
  kind: ReleaseKind;
  loaders: LoaderInfo[];
  javaMajor?: number;
  valid: boolean;
  problem?: string;
  config: InstanceConfig;
  modifiedAt: number;
}

interface CacheEntry {
  stamp: string;
  info: Omit<InstanceInfo, "config" | "gameDir" | "isolated">;
}

const FORBIDDEN_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
const FORBIDDEN_NAME_ALL = new RegExp(FORBIDDEN_NAME.source, "g");
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export function validateInstanceName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (trimmed !== name) return "名称首尾不能有空格";
  if (trimmed.length > 80) return "名称太长（最多 80 个字符）";
  if (FORBIDDEN_NAME.test(trimmed)) return '名称不能包含 \\ / : * ? " < > |';
  if (trimmed.endsWith(".")) return "名称不能以句点结尾";
  if (RESERVED.test(trimmed)) return "这是 Windows 保留名称";
  return undefined;
}

/** Make a user-facing name safe as a folder name and unique among `taken`. */
export function uniqueName(wanted: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const base = wanted.replace(FORBIDDEN_NAME_ALL, "_").replace(/\.+$/, "").trim() || "instance";
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function kindOf(type: string | undefined, id: string, mcVersion: string | undefined): ReleaseKind {
  if (type === "release" || type === "snapshot" || type === "old_beta" || type === "old_alpha") {
    // loader profiles report the vanilla type of their parent only sometimes
    return type;
  }
  const probe = mcVersion ?? id;
  if (/^\d+\.\d+(\.\d+)?$/.test(probe)) return "release";
  if (/snapshot|pre|rc|\d{2}w\d{2}/i.test(probe)) return "snapshot";
  if (/^b\d/.test(probe)) return "old_beta";
  if (/^a\d/.test(probe)) return "old_alpha";
  return "unknown";
}

export class InstanceStore {
  private cache = new Map<string, CacheEntry>();
  private migration = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  configPath(id: string) {
    return join(versionDir(this.root, id), "vitrine.json");
  }

  async loadConfig(id: string): Promise<InstanceConfig> {
    const stored = await readJsonOr<Partial<InstanceConfig>>(this.configPath(id), {});
    return { ...DEFAULT_INSTANCE_CONFIG, ...stored };
  }

  async saveConfig(id: string, patch: Partial<InstanceConfig>): Promise<InstanceConfig> {
    const next = { ...(await this.loadConfig(id)), ...patch };
    for (const key of Object.keys(next) as (keyof InstanceConfig)[]) if (next[key] === undefined) delete next[key];
    await writeJsonAtomic(this.configPath(id), next);
    return next;
  }

  /**
   * All instances now run from their own version folder. Sharing the root made it too easy for two
   * instances to see the same saves/options, so isolation is no longer configurable.
   */
  gameDirFor(id: string, _config: InstanceConfig, _loaders: LoaderInfo[], _kind: ReleaseKind): { gameDir: string; isolated: boolean } {
    return { gameDir: versionDir(this.root, id), isolated: true };
  }

  /** Copy saves from the old shared root once, before an instance switches to its own folder. */
  private migrateSharedSaves(id: string): Promise<void> {
    const running = this.migration.get(id);
    if (running) return running;
    const task = (async () => {
      const from = join(this.root, "saves");
      const to = join(versionDir(this.root, id), "saves");
      if (!(await exists(from)) || (await exists(to))) return;
      await copyDir(from, to);
    })().finally(() => this.migration.delete(id));
    this.migration.set(id, task);
    return task;
  }

  /** Folder names only (cheap; no analysis of the version JSONs). */
  async names(): Promise<string[]> {
    try {
      return (await readdir(versionsDir(this.root), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  async list(): Promise<InstanceInfo[]> {
    let names: string[] = [];
    try {
      names = (await readdir(versionsDir(this.root), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
    const out: InstanceInfo[] = [];
    for (const id of names) {
      const info = await this.get(id);
      if (info) out.push(info);
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async get(id: string): Promise<InstanceInfo | undefined> {
    const jsonPath = versionJsonPath(this.root, id);
    let stamp: string;
    try {
      const info = await stat(jsonPath);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      return undefined;
    }
    let cached = this.cache.get(id);
    if (!cached || cached.stamp !== stamp) {
      cached = { stamp, info: await this.analyze(id) };
      this.cache.set(id, cached);
    }
    const config = await this.loadConfig(id);
    const stored = await readJsonOr<Partial<InstanceConfig>>(this.configPath(id), {});
    const legacyIsolation = stored.isolation ?? "auto";
    const wasShared = legacyIsolation === "off" || (legacyIsolation === "auto" && cached.info.loaders.length === 0 && cached.info.kind === "release");
    if (wasShared) await this.migrateSharedSaves(id).catch(() => {});
    const { gameDir, isolated } = this.gameDirFor(id, config, cached.info.loaders, cached.info.kind);
    const info = { ...cached.info, config, gameDir, isolated, name: config.displayName || cached.info.name };
    // A vanilla copy installed under a custom name carries no trace of its version inside the JSON; the install recorded it.
    const recorded = config.installed?.mcVersion;
    if (!info.mcVersion && recorded) {
      info.mcVersion = recorded;
      info.javaMajor ??= fallbackJavaMajor(recorded);
    }
    return info;
  }

  invalidate(id?: string) {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  private async analyze(id: string): Promise<CacheEntry["info"]> {
    const dir = versionDir(this.root, id);
    const modifiedAt = (await stat(versionJsonPath(this.root, id)).catch(() => undefined))?.mtimeMs ?? 0;
    const base = { id, name: id, dir, modifiedAt, loaders: [] as LoaderInfo[], kind: "unknown" as ReleaseKind };
    try {
      const version = await resolveVersion(this.root, id);
      const ctx = defaultRuleContext();
      const loaders = detectLoaders(version, ctx);
      const mcVersion = detectMinecraftVersion(version);
      const kind = kindOf(version.chain.length > 1 ? undefined : version.type, id, mcVersion);
      const problems: string[] = [];
      if (!version.mainClass) problems.push("缺少主类（mainClass）");
      return {
        ...base,
        mcVersion,
        kind,
        loaders,
        javaMajor: requiredJavaMajor(version) ?? (mcVersion ? fallbackJavaMajor(mcVersion) : undefined),
        valid: problems.length === 0,
        problem: problems[0],
      };
    } catch (error) {
      if (error instanceof MissingVersionError) {
        return { ...base, valid: false, problem: `缺少依赖版本 ${error.versionId}` };
      }
      return { ...base, valid: false, problem: `版本 JSON 无法解析：${(error as Error).message}` };
    }
  }

  async exists(id: string): Promise<boolean> {
    return exists(versionJsonPath(this.root, id));
  }

  async rename(id: string, newId: string): Promise<void> {
    const problem = validateInstanceName(newId);
    if (problem) throw new Error(problem);
    if (await exists(versionDir(this.root, newId))) throw new Error(`已存在名为“${newId}”的实例`);
    const from = versionDir(this.root, id);
    const to = versionDir(this.root, newId);
    await rename(from, to);
    for (const ext of ["json", "jar"]) {
      const old = join(to, `${id}.${ext}`);
      if (await exists(old)) await rename(old, join(to, `${newId}.${ext}`));
    }
    const jsonPath = versionJsonPath(this.root, newId);
    const json = await readJson<Record<string, unknown>>(jsonPath);
    json.id = newId;
    await writeJsonAtomic(jsonPath, json);
    await removeRecursive(join(to, "natives")).catch(() => {});
    this.invalidate();
  }

  async duplicate(id: string, newId: string, onFile?: (count: number) => void): Promise<void> {
    const problem = validateInstanceName(newId);
    if (problem) throw new Error(problem);
    if (await exists(versionDir(this.root, newId))) throw new Error(`已存在名为“${newId}”的实例`);
    const from = versionDir(this.root, id);
    const to = versionDir(this.root, newId);
    let count = 0;
    await copyDir(from, to, (relative) => !relative.startsWith("natives") && !relative.startsWith("logs") && !relative.startsWith("crash-reports") && !relative.startsWith("webcache"));
    onFile?.(count++);
    for (const ext of ["json", "jar"]) {
      const old = join(to, `${id}.${ext}`);
      if (await exists(old)) await rename(old, join(to, `${newId}.${ext}`));
    }
    const jsonPath = versionJsonPath(this.root, newId);
    const json = await readJson<Record<string, unknown>>(jsonPath);
    json.id = newId;
    await writeJsonAtomic(jsonPath, json);
    await this.saveConfig(newId, { displayName: undefined, lastPlayed: undefined, playTimeMs: 0, createdAt: Date.now() });
    this.invalidate();
  }

  async remove(id: string): Promise<void> {
    await removeRecursive(versionDir(this.root, id));
    this.invalidate(id);
  }

  async hasJar(id: string): Promise<boolean> {
    return exists(versionJarPath(this.root, id));
  }

  /** Make sure the folder exists (used right before an install writes into it). */
  async ensureFolder(id: string): Promise<string> {
    const dir = versionDir(this.root, id);
    await ensureDir(dir);
    return dir;
  }
}

/** Seed the minimal files other launchers expect in a Minecraft root. */
export async function ensureRootLayout(root: string): Promise<void> {
  await ensureDir(join(root, "versions"));
  await ensureDir(join(root, "libraries"));
  await ensureDir(join(root, "assets"));
  const profiles = join(root, "launcher_profiles.json");
  if (!(await exists(profiles))) {
    await writeFile(profiles, JSON.stringify({ profiles: {}, clientToken: "vitrine", launcherVersion: { name: "Vitrine", format: 21 } }, null, 2));
  }
}
