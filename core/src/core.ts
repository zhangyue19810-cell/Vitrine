import { randomUUID } from "node:crypto";
import { cpus, homedir } from "node:os";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { AccountManager } from "./account/manager";
import { MicrosoftAuth, type MicrosoftEndpoints, MS_ENDPOINTS } from "./account/microsoft";
import { FileSecretStore, plainCipher, type Cipher } from "./account/secrets";
import type { LoginChallenge, PublicAccount } from "./account/types";
import { YggdrasilClient } from "./account/yggdrasil";
import { applyModUpdate, checkModUpdates, installContent, type ContentDeps, type InstallContentRequest, type ModUpdate } from "./content/browse";
import { createIconFetcher, type IconFetcher } from "./content/icons";
import { CurseForgeClient } from "./content/curseforge";
import { ModrinthClient } from "./content/modrinth";
import { installPlan, modpackPlan, STAGE_LABELS, type CoreEvent } from "./events";
import { detectJava, inspectJava, pickJava, type JavaInstall, type JavaRequirement } from "./java/detect";
import { componentForMajor, installMojangRuntime } from "./java/runtime";
import { listFabricLike, listForge, listNeoForge, listOptiFine, type LoaderVersion, type MetaDeps } from "./loaders/meta";
import { installInstance, type InstallDeps, type LoaderChoice } from "./loaders/install";
import type { InstallHooks } from "./loaders/forge-installer";
import { completeVersion, type GameEnv } from "./mc/files";
import { InstanceStore, ensureRootLayout, validateInstanceName, type InstanceConfig, type InstanceInfo, type IsolationMode } from "./mc/instances";
import { VersionCatalog, versionsCacheFile } from "./mc/manifest";
import type { ManifestEntry } from "./mc/types";
import { DEFAULT_ENGINE, DownloadEngine, type Progress } from "./net/download";
import { HttpClient } from "./net/http";
import { SourceRouter } from "./net/sources";
import { exportMrpack, type ExportResult } from "./pack/export";
import { adoptManualFiles, installPack, previewPack, readPackState, repairPack, type PackDeps, type PackHooks, type PackInstallResult } from "./pack/install";
import { installOnlinePack, type OnlineDeps } from "./pack/online";
import { GameManager, startLaunch, type LaunchOptions } from "./launch";
import { SettingsStore, type Settings } from "./settings";
import { TaskManager, type TaskContext } from "./tasks";
import { isAbort } from "./util/async";
import { ensureDir, exists, removeRecursive } from "./util/fsx";
import { Logger, type ScopedLog } from "./util/log";
import { currentOs, freeMemoryMB, totalMemoryMB, type OsInfo } from "./util/os";

/** Things only the desktop shell can do. All optional: the core also runs headless (dev server, tests). */
export interface HostBridge {
  openPath?(path: string): Promise<void> | void;
  showItemInFolder?(path: string): void;
  openExternal?(url: string): Promise<void> | void;
  /** Native file dialogs. */
  pickFile?(options: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[] | undefined>;
  pickFolder?(options: { title?: string }): Promise<string | undefined>;
  saveFile?(options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | undefined>;
  /** Current system proxy for a URL, if the platform has one the Node network stack cannot see. */
  systemProxy?(url: string): string | undefined;
}

export interface CoreOptions {
  dataDir: string;
  version?: string;
  userAgent?: string;
  /** Wraps stored secrets (Electron's safeStorage). Without it tokens are only obscured, not encrypted. */
  cipher?: Cipher;
  host?: HostBridge;
  os?: OsInfo;
  microsoftEndpoints?: MicrosoftEndpoints;
  /** Where Minecraft lives while the settings do not say otherwise. */
  defaultRoot?: string;
}

export interface Paths {
  dataDir: string;
  cacheDir: string;
  logsDir: string;
  workDir: string;
  authlibDir: string;
  argFilesDir: string;
  javaDir: string;
  settingsFile: string;
  accountsFile: string;
  secretsFile: string;
}

export interface InstanceSummary extends InstanceInfo {
  modCount: number;
  running: boolean;
  /** A modpack install that still lacks required files. */
  incomplete: boolean;
  size?: undefined;
}

const NO_PROXY_SPLIT = /[\s,]+/;

function envProxy(url: string): string | undefined {
  const get = (name: string) => process.env[name] ?? process.env[name.toLowerCase()];
  try {
    const host = new URL(url).hostname.toLowerCase();
    const bypass = (get("NO_PROXY") ?? "").split(NO_PROXY_SPLIT).filter(Boolean);
    if (bypass.some((entry) => entry === "*" || host === entry.replace(/^\./, "") || host.endsWith(`.${entry.replace(/^\./, "")}`))) return undefined;
  } catch {
    return undefined;
  }
  return get("HTTPS_PROXY") ?? get("ALL_PROXY");
}

async function countJars(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => /\.jar(\.disabled)?$/i.test(name)).length;
  } catch {
    return 0;
  }
}

const INSTANCE_CONFIG_KEYS = new Set<keyof InstanceConfig>(["displayName", "note", "icon", "group", "favorite", "isolation", "javaPath", "memory", "jvmPreset", "jvmArgs", "gameArgs", "width", "height", "fullscreen", "accountId", "autoJoin", "preLaunch", "wrapper", "env"]);

/** Accept only the fields a user may edit, with the right types. Internal fields (play time, origin…) are not writable. */
export function sanitizeInstanceConfig(patch: unknown): Partial<InstanceConfig> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("实例设置格式不正确");
  const out: Record<string, unknown> = {};
  const text = (key: string, value: unknown, max: number) => {
    if (value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > max) throw new Error(`“${key}”无效或太长`);
    return value.trim() || undefined;
  };
  const whole = (key: string, value: unknown, min: number, max: number) => {
    if (value === null || value === 0) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`“${key}”必须是数字`);
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!INSTANCE_CONFIG_KEYS.has(key as keyof InstanceConfig)) continue;
    switch (key) {
      case "displayName":
        out[key] = text(key, value, 80);
        break;
      case "note":
        out[key] = text(key, value, 1000);
        break;
      case "icon":
        out[key] = text(key, value, 600_000);
        break;
      case "group":
      case "accountId":
        out[key] = text(key, value, 80);
        break;
      case "javaPath":
      case "jvmArgs":
      case "gameArgs":
      case "autoJoin":
      case "preLaunch":
      case "wrapper":
        out[key] = text(key, value, 4000);
        break;
      case "favorite":
      case "fullscreen":
        out[key] = value === null ? undefined : Boolean(value);
        break;
      case "isolation":
        if (value !== "auto" && value !== "on" && value !== "off") throw new Error("“隔离模式”无效");
        out[key] = value as IsolationMode;
        break;
      case "memory":
        out[key] = value === "auto" || value === null ? undefined : whole(key, value, 512, 262_144);
        break;
      case "jvmPreset":
        if (value !== null && !["default", "mojang", "large-modpack", "zgc"].includes(value as string)) throw new Error("“JVM 预设”无效");
        out[key] = value ?? undefined;
        break;
      case "width":
      case "height":
        out[key] = whole(key, value, 0, 16384);
        break;
      case "env": {
        if (value === null) {
          out[key] = undefined;
          break;
        }
        if (typeof value !== "object" || Array.isArray(value)) throw new Error("“环境变量”格式不正确");
        const entries = Object.entries(value as Record<string, unknown>).filter(([name, content]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof content === "string");
        out[key] = entries.length ? Object.fromEntries(entries) : undefined;
        break;
      }
    }
  }
  return out as Partial<InstanceConfig>;
}

export class Core {
  readonly version: string;
  readonly os: OsInfo;
  readonly paths: Paths;
  readonly logger: Logger;
  readonly log: ScopedLog;
  readonly settings: SettingsStore;
  readonly http: HttpClient;
  /** Icons of online projects as data: URLs (the 3D interface cannot read cross-origin images). */
  readonly icons: IconFetcher;
  readonly router: SourceRouter;
  readonly engine: DownloadEngine;
  readonly tasks: TaskManager;
  readonly secrets: FileSecretStore;
  readonly accounts: AccountManager;
  readonly modrinth: ModrinthClient;
  readonly curseforge: CurseForgeClient;
  readonly games: GameManager;
  readonly host: HostBridge;

  root = "";
  instances!: InstanceStore;
  env!: GameEnv;
  catalog!: VersionCatalog;
  meta!: MetaDeps;

  private readonly listeners = new Set<(event: CoreEvent) => void>();
  private javaCache?: { at: number; installs: JavaInstall[] };
  private readonly logins = new Map<string, AbortController>();
  private readonly defaultRoot: string;
  private disposed = false;

  private constructor(options: CoreOptions) {
    this.version = options.version ?? "0.1.0";
    this.os = options.os ?? currentOs();
    this.host = options.host ?? {};
    const dataDir = options.dataDir;
    this.paths = {
      dataDir,
      cacheDir: join(dataDir, "cache"),
      logsDir: join(dataDir, "logs"),
      workDir: join(dataDir, "work"),
      authlibDir: join(dataDir, "authlib"),
      argFilesDir: join(dataDir, "argfiles"),
      javaDir: join(dataDir, "java"),
      settingsFile: join(dataDir, "settings.json"),
      accountsFile: join(dataDir, "accounts.json"),
      secretsFile: join(dataDir, "secrets.json"),
    };
    this.defaultRoot = options.defaultRoot ?? join(dataDir, "minecraft");
    this.logger = new Logger(join(this.paths.logsDir, "launcher.log"), 3000, "info");
    this.log = this.logger.scope("core");
    this.settings = new SettingsStore(this.paths.settingsFile);

    this.http = new HttpClient({
      userAgent: options.userAgent ?? `Vitrine/${this.version}`,
      getProxy: (url) => {
        const network = this.settings.peek().network;
        if (network.proxy === "none") return null;
        if (network.proxy === "custom") return network.proxyUrl || null;
        return this.host.systemProxy?.(url) ?? envProxy(url);
      },
    });
    this.icons = createIconFetcher(this.http);
    this.router = new SourceRouter(() => this.settings.peek().sources);
    this.engine = new DownloadEngine(this.http, () => {
      const download = this.settings.peek().download;
      return { ...DEFAULT_ENGINE, concurrency: download.concurrency, segments: download.segments, retries: download.retries, speedLimit: download.speedLimitKBps * 1024 };
    });
    this.tasks = new TaskManager({ maxConcurrent: 2, labels: STAGE_LABELS });
    this.tasks.onEvent((event) => this.emit(event));
    this.secrets = new FileSecretStore(this.paths.secretsFile, options.cipher ?? plainCipher);
    this.accounts = new AccountManager({
      file: this.paths.accountsFile,
      secrets: this.secrets,
      microsoft: new MicrosoftAuth(this.http, () => this.settings.peek().accounts.msClientId, options.microsoftEndpoints ?? MS_ENDPOINTS),
      yggdrasil: new YggdrasilClient(this.http),
      ownerUuid: () => this.settings.peek().accounts.ownerUuid || undefined,
    });
    const apiDeps = { http: this.http, router: this.router, log: this.logger.scope("content") };
    this.modrinth = new ModrinthClient(apiDeps);
    this.curseforge = new CurseForgeClient(apiDeps, () => this.settings.peek().accounts.curseforgeKey || undefined);
    this.games = new GameManager(this);
  }

  /** Create and initialise a core: folders, settings, the game root. */
  static async create(options: CoreOptions): Promise<Core> {
    const core = new Core(options);
    for (const dir of [core.paths.dataDir, core.paths.cacheDir, core.paths.logsDir, core.paths.workDir]) await ensureDir(dir);
    await core.settings.load();
    await core.useRoot(core.settings.peek().gameRoot || core.defaultRoot);
    core.settings.onChange((settings, previous) => {
      core.emit({ type: "settings", settings });
      const wanted = settings.gameRoot || core.defaultRoot;
      if (wanted !== core.root) void core.useRoot(wanted).then(() => core.emit({ type: "instances" })).catch((error) => core.log.error(`cannot switch game folder: ${(error as Error).message}`));
      if (settings.accounts.msClientId !== previous.accounts.msClientId || settings.accounts.ownerUuid !== previous.accounts.ownerUuid) core.emit({ type: "accounts" });
    });
    return core;
  }

  private async useRoot(root: string) {
    await ensureRootLayout(root);
    this.root = root;
    this.instances = new InstanceStore(root);
    this.env = { root, http: this.http, router: this.router, engine: this.engine, log: this.logger.scope("game"), os: this.os };
    this.catalog = new VersionCatalog(this.http, this.router, versionsCacheFile(this.paths.cacheDir), this.logger.scope("versions"));
    this.meta = { http: this.http, router: this.router, log: this.logger.scope("loaders"), mirrorBase: () => this.settings.peek().sources.mirrorBase };
    this.javaCache = undefined;
  }

  // ------------------------------------------------------------------------------------------ events

  on(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CoreEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn(`event listener failed: ${(error as Error).message}`);
      }
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.logins.values()) controller.abort();
    this.tasks.cancelAll();
    await this.tasks.idle().catch(() => {});
    this.http.destroy();
  }

  // ------------------------------------------------------------------------------------------ java

  async javaInstalls(force = false): Promise<JavaInstall[]> {
    if (!force && this.javaCache && Date.now() - this.javaCache.at < 60_000) return this.javaCache.installs;
    const installs = await detectJava({
      os: this.os,
      extraDirs: [
        { dir: join(this.root, "runtime"), source: "mojang" },
        { dir: this.paths.javaDir, source: "vitrine" },
      ],
      extraPaths: this.settings.peek().java.extraPaths,
    });
    this.javaCache = { at: Date.now(), installs };
    return installs;
  }

  /** Find a Java that satisfies the requirement, or download Mojang's runtime for it. */
  async ensureJava(requirement: JavaRequirement, component: string | undefined, signal?: AbortSignal, onProgress?: (progress: Progress) => void): Promise<{ path: string; major: number; is64: boolean }> {
    const pick = pickJava(await this.javaInstalls(), requirement);
    if (pick) return { path: pick.path, major: pick.major, is64: pick.is64 };
    const range = requirement.max !== undefined ? `${requirement.min}–${requirement.max}` : `${requirement.min} 或更高`;
    if (!this.settings.peek().java.autoInstall) throw new Error(`没有找到可用的 Java ${range}。请在 设置 → Java 里添加，或者打开“自动下载 Java”。`);
    const wanted = component ?? componentForMajor(requirement.min);
    this.log.info(`no Java ${range} installed; downloading Mojang runtime ${wanted}`);
    const runtime = await installMojangRuntime({ root: this.root, component: wanted, http: this.http, router: this.router, engine: this.engine, os: this.os, log: this.logger.scope("java"), signal, onProgress });
    this.javaCache = undefined;
    const inspected = await inspectJava(runtime.home, "mojang", { os: this.os });
    if (!inspected) throw new Error("Java 下载完成但无法运行，可能被杀毒软件拦截。");
    if (inspected.major < requirement.min || (requirement.max !== undefined && inspected.major > requirement.max)) {
      throw new Error(`下载到的 Java ${inspected.major} 不符合要求（需要 ${range}）。请手动指定 Java。`);
    }
    return { path: inspected.path, major: inspected.major, is64: inspected.is64 };
  }

  // ------------------------------------------------------------------------------------------ dependencies for the libraries

  installDeps(signal?: AbortSignal): InstallDeps {
    return {
      env: this.env,
      catalog: this.catalog,
      meta: { ...this.meta, signal },
      instances: this.instances,
      ensureJava: (requirement, component, abort) => this.ensureJava(requirement, component, abort ?? signal),
      workDir: this.paths.workDir,
      mirrorBase: () => this.settings.peek().sources.mirrorBase,
    };
  }

  packDeps(signal?: AbortSignal): PackDeps {
    return { install: this.installDeps(signal), curseforge: this.curseforge, concurrency: () => this.settings.peek().download.concurrency };
  }

  onlineDeps(signal?: AbortSignal): OnlineDeps {
    return { ...this.packDeps(signal), modrinth: this.modrinth, workDir: this.paths.workDir };
  }

  contentDeps(): ContentDeps {
    return { modrinth: this.modrinth, curseforge: this.curseforge, router: this.router, engine: this.engine };
  }

  private hooks(ctx: TaskContext): PackHooks {
    return {
      stage: (stage, detail) => ctx.stage(stage, detail),
      progress: (progress, stage) => ctx.progress(progress, stage),
      output: (line) => ctx.log(line),
      warning: (message) => ctx.warn(message),
      file: (event) => {
        if (event.status === "failed") ctx.log(`✖ ${event.item.label ?? basename(event.item.dest)}：${event.error ?? "下载失败"}`);
      },
    };
  }

  // ------------------------------------------------------------------------------------------ versions & loaders

  async listVersions(options: { force?: boolean; signal?: AbortSignal } = {}) {
    const manifest = await this.catalog.list({ force: options.force, signal: options.signal });
    return {
      latest: manifest.latest,
      versions: manifest.versions.map((entry: ManifestEntry) => ({ id: entry.id, type: entry.type, releaseTime: entry.releaseTime })),
    };
  }

  async listLoaderVersions(kind: string, mcVersion: string, signal?: AbortSignal): Promise<LoaderVersion[]> {
    const deps = { ...this.meta, signal };
    switch (kind) {
      case "fabric":
      case "quilt":
        return listFabricLike(deps, kind, mcVersion);
      case "forge":
        return listForge(deps, mcVersion);
      case "neoforge":
        return listNeoForge(deps, mcVersion);
      case "optifine":
        return listOptiFine(deps, mcVersion);
      default:
        throw new Error(`不支持的加载器：${kind}`);
    }
  }

  /** How many versions of each loader exist for a game version, so the wizard can grey out the impossible ones. */
  async loaderOverview(mcVersion: string, signal?: AbortSignal): Promise<Record<string, { count: number; error?: string; latest?: string; recommended?: string }>> {
    const kinds = ["fabric", "quilt", "forge", "neoforge", "optifine"] as const;
    const results = await Promise.allSettled(kinds.map((kind) => this.listLoaderVersions(kind, mcVersion, signal)));
    const out: Record<string, { count: number; error?: string; latest?: string; recommended?: string }> = {};
    kinds.forEach((kind, index) => {
      const result = results[index];
      if (result.status === "fulfilled") {
        const list = result.value;
        out[kind] = { count: list.length, latest: list[0]?.version, recommended: list.find((entry) => entry.recommended)?.version };
      } else out[kind] = { count: 0, error: (result.reason as Error)?.message ?? String(result.reason) };
    });
    return out;
  }

  // ------------------------------------------------------------------------------------------ instances

  async listInstances(): Promise<InstanceSummary[]> {
    const list = await this.instances.list();
    return Promise.all(
      list.map(async (info) => {
        const state = await readPackState(this.root, info.id).catch(() => undefined);
        return { ...info, modCount: await countJars(join(info.gameDir, "mods")), running: Boolean(this.games.runningFor(info.id)), incomplete: state ? !state.complete : false };
      }),
    );
  }

  async requireInstance(id: string): Promise<InstanceInfo> {
    const info = await this.instances.get(id);
    if (!info) throw new Error("找不到这个实例，它可能已被删除。");
    return info;
  }

  async gameDirOf(id: string): Promise<string> {
    return (await this.requireInstance(id)).gameDir;
  }

  async setInstanceConfig(id: string, patch: unknown): Promise<InstanceInfo> {
    await this.requireInstance(id);
    await this.instances.saveConfig(id, sanitizeInstanceConfig(patch));
    this.instances.invalidate(id);
    this.emit({ type: "instances", ids: [id] });
    return this.requireInstance(id);
  }

  private async assertIdle(id: string, action: string) {
    if (this.games.runningFor(id)) throw new Error(`这个实例正在运行，无法${action}。`);
    if (this.tasks.list().some((task) => task.instanceId === id && (task.state === "queued" || task.state === "running"))) throw new Error(`这个实例有任务正在进行，请等它结束后再${action}。`);
  }

  async renameInstance(id: string, name: string) {
    await this.assertIdle(id, "重命名");
    await this.instances.rename(id, name);
    this.emit({ type: "instances" });
  }

  async removeInstance(id: string) {
    await this.assertIdle(id, "删除");
    await this.instances.remove(id);
    this.emit({ type: "instances" });
  }

  duplicateInstance(id: string, name: string): { taskId: string } {
    const problem = validateInstanceName(name);
    if (problem) throw new Error(problem);
    const { id: taskId } = this.tasks.start({
      kind: "other",
      title: `复制 ${id}`,
      instanceId: id,
      run: async (ctx) => {
        ctx.log(`复制到 ${name}…`);
        await this.instances.duplicate(id, name);
        this.emit({ type: "instances" });
        return { id: name };
      },
    });
    return { taskId };
  }

  /** Folders the interface may open from an instance page. */
  async openInstanceFolder(id: string, sub = ""): Promise<string> {
    const allowed = new Set(["", "mods", "saves", "resourcepacks", "shaderpacks", "screenshots", "logs", "crash-reports", "config", "datapacks"]);
    if (!allowed.has(sub)) throw new Error("不能打开这个文件夹");
    const dir = sub ? join(await this.gameDirOf(id), sub) : await this.gameDirOf(id);
    await mkdir(dir, { recursive: true });
    await this.openPath(dir);
    return dir;
  }

  async openPath(path: string) {
    if (!this.host.openPath) throw new Error("当前运行环境（没有桌面外壳）无法打开文件夹");
    await this.host.openPath(path);
  }

  // ------------------------------------------------------------------------------------------ installs (tasks)

  /** Install a vanilla or loader instance. Returns at once with the task id. */
  createInstance(request: { name: string; mcVersion: string; loader?: LoaderChoice; isolation?: IsolationMode }): { taskId: string } {
    const problem = validateInstanceName(request.name);
    if (problem) throw new Error(problem);
    if (!request.mcVersion) throw new Error("请选择游戏版本");
    const { id: taskId } = this.tasks.start({
      kind: "install",
      title: `安装 ${request.name}`,
      instanceId: request.name,
      run: async (ctx) => {
        ctx.plan(installPlan(request.loader?.kind));
        const result = await installInstance(this.installDeps(ctx.signal), { ...request, signal: ctx.signal, hooks: this.hooks(ctx) as InstallHooks });
        this.emit({ type: "instances", ids: [result.id] });
        return result;
      },
    });
    return { taskId };
  }

  /** Import a local modpack archive (.mrpack, CurseForge zip, MultiMC/Prism zip, MCBBS). */
  installModpack(request: { file: string; name?: string; skipOptional?: boolean | string[] }): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "modpack",
      title: `导入整合包 ${basename(request.file)}`,
      run: async (ctx): Promise<PackInstallResult> => {
        ctx.plan(modpackPlan(undefined));
        ctx.stage("pack-read");
        const preview = await previewPack(request.file);
        ctx.plan(modpackPlan(preview.loader?.kind));
        ctx.setTitle(`导入整合包 ${preview.name}`);
        const result = await installPack(this.packDeps(ctx.signal), { ...request, signal: ctx.signal, hooks: this.hooks(ctx), concurrency: this.settings.peek().download.concurrency });
        this.emit({ type: "instances", ids: [result.id] });
        return result;
      },
    });
    return { taskId };
  }

  /** Download and install a modpack from Modrinth or CurseForge. */
  installOnlineModpack(request: { source: "modrinth" | "curseforge"; projectId: string; versionId?: string; name?: string; title?: string }): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "modpack",
      title: `安装整合包 ${request.title ?? request.name ?? request.projectId}`,
      run: async (ctx): Promise<PackInstallResult> => {
        ctx.plan(modpackPlan(undefined, true));
        const result = await installOnlinePack(this.onlineDeps(ctx.signal), { ...request, signal: ctx.signal, hooks: this.hooks(ctx) });
        this.emit({ type: "instances", ids: [result.id] });
        return result;
      },
    });
    return { taskId };
  }

  /** Re-check an instance's files: modpack instances re-download missing pack files, all of them re-verify the game files. */
  repairInstance(id: string, options: { verify?: "size" | "hash" } = {}): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "repair",
      title: `修复 ${id}`,
      instanceId: id,
      run: async (ctx) => {
        await this.requireInstance(id);
        const verify = options.verify ?? "size";
        const state = await readPackState(this.root, id).catch(() => undefined);
        let pack: Awaited<ReturnType<typeof repairPack>> | undefined;
        if (state) {
          ctx.plan([{ id: "pack-files", label: STAGE_LABELS["pack-files"] }, { id: "libraries", label: STAGE_LABELS.libraries }, { id: "assets", label: STAGE_LABELS.assets }]);
          pack = await repairPack(this.packDeps(ctx.signal), id, { signal: ctx.signal, hooks: this.hooks(ctx), verify, concurrency: this.settings.peek().download.concurrency });
        } else ctx.plan([{ id: "libraries", label: STAGE_LABELS.libraries }, { id: "assets", label: STAGE_LABELS.assets }]);
        const files = await completeVersion(this.env, id, {
          signal: ctx.signal,
          verify,
          concurrency: this.settings.peek().download.concurrency,
          onStage: (stage) => ctx.stage(stage === "files" ? "libraries" : "assets"),
          onProgress: (progress, stage) => ctx.progress(progress, stage === "files" ? "libraries" : "assets"),
        });
        this.instances.invalidate(id);
        this.emit({ type: "instances", ids: [id] });
        return { pack, downloaded: files.downloaded, skipped: files.skipped, missingLocal: files.missingLocal.length };
      },
    });
    return { taskId };
  }

  /** Use files the player downloaded by hand for the pack files that restrict direct downloads. */
  adoptManual(id: string, sources: string[]) {
    return adoptManualFiles(this.packDeps(), id, sources);
  }

  exportModpack(request: { instanceId: string; dest: string; name: string; version: string; summary?: string; include: string[]; identify?: boolean }): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "export",
      title: `导出整合包 ${request.name}`,
      instanceId: request.instanceId,
      run: async (ctx): Promise<ExportResult> => {
        const info = await this.requireInstance(request.instanceId);
        if (!info.mcVersion) throw new Error("无法确定这个实例的游戏版本");
        const loader = info.loaders.find((entry) => ["fabric", "quilt", "forge", "neoforge"].includes(entry.kind));
        ctx.plan(["scan", "hash", "lookup", "write"].map((id) => ({ id, label: STAGE_LABELS[id] ?? id })));
        return exportMrpack(
          { modrinth: this.modrinth },
          {
            gameDir: info.gameDir,
            instanceId: info.id,
            dest: request.dest,
            name: request.name,
            version: request.version,
            summary: request.summary,
            mcVersion: info.mcVersion,
            loader: loader ? { kind: loader.kind as "fabric" | "quilt" | "forge" | "neoforge", version: loader.version ?? "" } : undefined,
            include: request.include,
            identify: request.identify,
            signal: ctx.signal,
            onProgress: (progress) => {
              ctx.stage(progress.stage);
              ctx.log(`${STAGE_LABELS[progress.stage] ?? progress.stage} ${progress.done}/${progress.total}`);
            },
          },
        );
      },
    });
    return { taskId };
  }

  /** Install a mod / resource pack / shader / data pack into an instance. */
  installContentTask(request: Omit<InstallContentRequest, "gameDir" | "signal" | "onProgress" | "onPlan"> & { instanceId: string; title?: string }): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "content",
      title: `安装 ${request.title ?? request.projectId}`,
      instanceId: request.instanceId,
      run: async (ctx) => {
        const gameDir = await this.gameDirOf(request.instanceId);
        const { instanceId: _unused, title: _title, ...rest } = request;
        void _unused;
        void _title;
        ctx.plan([{ id: "files", label: "下载文件" }]);
        ctx.stage("files");
        const result = await installContent(this.contentDeps(), {
          ...rest,
          gameDir,
          signal: ctx.signal,
          onProgress: (progress) => ctx.progress(progress, "files"),
          onPlan: (plan) => ctx.log(`将安装：${plan.map((item) => `${item.title} ${item.version}${item.dependency ? "（前置）" : ""}`).join("、")}`),
        });
        for (const item of result.skipped) ctx.log(`跳过 ${item.title}：${item.reason}`);
        for (const item of result.failed) ctx.warn(`${item.title} 安装失败：${item.error}${item.pageUrl ? `（可手动下载：${item.pageUrl}）` : ""}`);
        this.emit({ type: "instances", ids: [request.instanceId] });
        return result;
      },
    });
    return { taskId };
  }

  checkUpdatesTask(instanceId: string): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "update",
      title: "检查模组更新",
      instanceId,
      run: async (ctx) => {
        const info = await this.requireInstance(instanceId);
        if (!info.mcVersion) throw new Error("无法确定这个实例的游戏版本");
        const loaders = info.loaders.map((loader) => loader.kind).filter((kind) => ["fabric", "quilt", "forge", "neoforge"].includes(kind));
        ctx.plan([{ id: "scan", label: "扫描模组" }, { id: "lookup", label: "查询新版本" }]);
        ctx.stage("scan");
        return checkModUpdates(this.contentDeps(), info.gameDir, { loaders: loaders.length ? loaders : ["fabric", "forge", "neoforge", "quilt"], gameVersions: [info.mcVersion] }, {
          signal: ctx.signal,
          onProgress: (done, total) => {
            ctx.stage(done >= total ? "lookup" : "scan");
            ctx.log(`${done}/${total}`);
          },
        });
      },
    });
    return { taskId };
  }

  applyUpdatesTask(instanceId: string, updates: ModUpdate[]): { taskId: string } {
    const { id: taskId } = this.tasks.start({
      kind: "update",
      title: `更新 ${updates.length} 个模组`,
      instanceId,
      run: async (ctx) => {
        const gameDir = await this.gameDirOf(instanceId);
        ctx.plan([{ id: "files", label: "下载新版本" }]);
        ctx.stage("files");
        const done: string[] = [];
        const failed: { title: string; error: string }[] = [];
        for (const update of updates) {
          if (ctx.signal.aborted) break;
          try {
            await applyModUpdate(this.contentDeps(), gameDir, update, { signal: ctx.signal, onProgress: (progress) => ctx.progress(progress, "files") });
            done.push(update.title);
            ctx.log(`✔ ${update.title} → ${update.latest.versionNumber}`);
          } catch (error) {
            if (isAbort(error)) throw error;
            failed.push({ title: update.title, error: (error as Error).message });
            ctx.warn(`${update.title} 更新失败：${(error as Error).message}`);
          }
        }
        this.emit({ type: "instances", ids: [instanceId] });
        return { updated: done, failed };
      },
    });
    return { taskId };
  }

  /** Start the preparation + launch task; resolves with the task id as soon as it exists. */
  launch(id: string, options: LaunchOptions = {}) {
    return startLaunch(this, id, options);
  }

  // ------------------------------------------------------------------------------------------ accounts

  async beginMicrosoftLogin(): Promise<{ loginId: string; challenge: LoginChallenge }> {
    const controller = new AbortController();
    const { challenge, done } = await this.accounts.beginMicrosoft(controller.signal);
    const loginId = randomUUID();
    this.logins.set(loginId, controller);
    done.then(
      (account: PublicAccount) => {
        this.logins.delete(loginId);
        this.emit({ type: "login", loginId, status: "done", account });
        this.emit({ type: "accounts" });
      },
      (error: Error & { reason?: string }) => {
        this.logins.delete(loginId);
        const cancelled = controller.signal.aborted;
        this.emit({ type: "login", loginId, status: cancelled ? "cancelled" : "error", error: cancelled ? undefined : error.message, reason: error.reason });
      },
    );
    return { loginId, challenge };
  }

  cancelLogin(loginId: string): boolean {
    const controller = this.logins.get(loginId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // ------------------------------------------------------------------------------------------ system

  /** Existing Minecraft folders the player may want to reuse (official launcher, other launchers). */
  async suggestRoots(): Promise<{ path: string; kind: string; versions: number }[]> {
    const home = homedir();
    const candidates: { path: string; kind: string }[] = [];
    if (this.os.name === "windows") {
      const appData = process.env.APPDATA;
      if (appData) candidates.push({ path: join(appData, ".minecraft"), kind: "官方启动器" });
    } else if (this.os.name === "osx") candidates.push({ path: join(home, "Library", "Application Support", "minecraft"), kind: "官方启动器" });
    else candidates.push({ path: join(home, ".minecraft"), kind: "官方启动器" });
    const out: { path: string; kind: string; versions: number }[] = [];
    for (const candidate of candidates) {
      if (!(await exists(join(candidate.path, "versions")))) continue;
      const versions = (await readdir(join(candidate.path, "versions"), { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).length;
      out.push({ ...candidate, versions });
    }
    return out;
  }

  async systemInfo() {
    return {
      version: this.version,
      os: this.os,
      cpuCount: cpus().length,
      totalMemoryMB: totalMemoryMB(),
      freeMemoryMB: freeMemoryMB(),
      dataDir: this.paths.dataDir,
      root: this.root,
      hasCurseForgeKey: this.curseforge.hasKey,
      hasMicrosoftClientId: Boolean(this.settings.peek().accounts.msClientId),
    };
  }

  settingsSnapshot(): Settings {
    return this.settings.get();
  }

  /** Delete a folder inside the data directory (cache clearing), refusing anything else. */
  async clearCache(): Promise<void> {
    await removeRecursive(this.paths.workDir);
    await ensureDir(this.paths.workDir);
  }
}
