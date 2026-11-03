import { copyFile } from "node:fs/promises";
import { readJsonOr, writeJsonAtomic } from "./util/fsx";
import { DEFAULT_SOURCES, type SourcePolicy, type SourceSettings } from "./net/sources";
import type { JvmPreset } from "./mc/jvm";

export type AfterLaunch = "keep" | "minimize" | "hide" | "close";

export interface Settings {
  version: 1;
  /** Folder holding versions/, libraries/ and assets/. Empty = `<data>/minecraft`. */
  gameRoot: string;
  sources: SourceSettings;
  download: { concurrency: number; segments: number; /** KiB/s, 0 = unlimited */ speedLimitKBps: number; retries: number };
  network: { proxy: "system" | "none" | "custom"; proxyUrl: string };
  java: { autoInstall: boolean; extraPaths: string[] };
  launch: {
    memory: "auto" | number;
    jvmPreset: JvmPreset;
    jvmArgs: string;
    gameArgs: string;
    width: number;
    height: number;
    fullscreen: boolean;
    afterLaunch: AfterLaunch;
    versionType: string;
  };
  accounts: { msClientId: string; curseforgeKey: string; /** UUID offered when adding an offline account */ ownerUuid: string };
  ui: {
    /** "auto" follows the operating system's reduced-motion setting. */
    motion: "auto" | "full" | "reduced";
    /** Frame-rate ceiling of the 3D scene. */
    fps: "auto" | 30 | 60 | 120;
    /** Stop rendering completely while a game is running. */
    pauseWhenGameRuns: boolean;
    /** Give the 3D scene's GPU memory back while a game runs behind a hidden launcher (the scene is rebuilt on return). */
    releaseGpuWhenGameRuns: boolean;
    /** Colour scheme of the interface; "auto" follows the operating system. */
    theme: "auto" | "light" | "dark";
    /** What the 3D scene does when the launcher window loses focus. */
    whenUnfocused: "pause" | "throttle" | "full";
    quality: "auto" | "high" | "medium" | "low";
    sounds: boolean;
    soundVolume: number;
    splash: "full" | "short" | "off";
    scale: number;
  };
}

/** Optional owner UUID for offline accounts. Empty by default; the player sets it in settings. */
export const DEFAULT_OWNER_UUID = "";

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  gameRoot: "",
  sources: { ...DEFAULT_SOURCES },
  download: { concurrency: 32, segments: 4, speedLimitKBps: 0, retries: 3 },
  network: { proxy: "system", proxyUrl: "" },
  java: { autoInstall: true, extraPaths: [] },
  launch: { memory: "auto", jvmPreset: "default", jvmArgs: "", gameArgs: "", width: 0, height: 0, fullscreen: false, afterLaunch: "minimize", versionType: "Vitrine" },
  accounts: { msClientId: "", curseforgeKey: "", ownerUuid: DEFAULT_OWNER_UUID },
  ui: { motion: "auto", fps: "auto", pauseWhenGameRuns: true, releaseGpuWhenGameRuns: true, theme: "auto", whenUnfocused: "pause", quality: "auto", sounds: true, soundVolume: 0.5, splash: "full", scale: 1 },
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

class SettingsError extends Error {
  readonly name = "SettingsError";
}

function oneOf<T extends string | number>(label: string, value: unknown, allowed: readonly T[]): T {
  if (allowed.includes(value as T)) return value as T;
  throw new SettingsError(`${label} 的值无效`);
}

function int(label: string, value: unknown, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new SettingsError(`${label} 必须是数字`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new SettingsError(`${label} 必须是 开/关`);
  return value;
}

function text(label: string, value: unknown, max = 2000): string {
  if (typeof value !== "string") throw new SettingsError(`${label} 必须是文本`);
  if (value.length > max) throw new SettingsError(`${label} 太长`);
  return value.trim();
}

function url(label: string, value: unknown, schemes: string[] = ["http:", "https:"]): string {
  const raw = text(label, value, 500);
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SettingsError(`${label} 不是有效的网址`);
  }
  if (!schemes.includes(parsed.protocol)) throw new SettingsError(`${label} 必须以 ${schemes.map((s) => `${s}//`).join(" 或 ")} 开头`);
  return raw.replace(/\/+$/, "");
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const POLICIES: SourcePolicy[] = ["official-first", "mirror-first", "official-only", "mirror-only"];

/** Apply a partial update on top of `current`, validating every field that is present. Unknown keys are ignored. */
export function applySettings(current: Settings, patch: unknown): Settings {
  if (!isObject(patch)) throw new SettingsError("设置格式不正确");
  const next: Settings = structuredClone(current);
  const section = (name: string): Json | undefined => {
    const value = patch[name];
    if (value === undefined) return undefined;
    if (!isObject(value)) throw new SettingsError(`${name} 的格式不正确`);
    return value;
  };

  if (patch.gameRoot !== undefined) next.gameRoot = text("游戏目录", patch.gameRoot, 1000);

  const sources = section("sources");
  if (sources) {
    if (sources.policy !== undefined) next.sources.policy = oneOf("下载源策略", sources.policy, POLICIES);
    if (sources.contentPolicy !== undefined) next.sources.contentPolicy = oneOf("模组源策略", sources.contentPolicy, POLICIES);
    if (sources.mirrorBase !== undefined) next.sources.mirrorBase = url("镜像地址", sources.mirrorBase) || DEFAULT_SOURCES.mirrorBase;
    if (sources.contentMirrorBase !== undefined) next.sources.contentMirrorBase = url("模组镜像地址", sources.contentMirrorBase) || DEFAULT_SOURCES.contentMirrorBase;
  }

  const download = section("download");
  if (download) {
    if (download.concurrency !== undefined) next.download.concurrency = int("下载线程数", download.concurrency, 1, 128);
    if (download.segments !== undefined) next.download.segments = int("单文件分段数", download.segments, 1, 16);
    if (download.speedLimitKBps !== undefined) next.download.speedLimitKBps = int("限速", download.speedLimitKBps, 0, 10_000_000);
    if (download.retries !== undefined) next.download.retries = int("重试次数", download.retries, 0, 10);
  }

  const network = section("network");
  if (network) {
    if (network.proxy !== undefined) next.network.proxy = oneOf("代理模式", network.proxy, ["system", "none", "custom"] as const);
    if (network.proxyUrl !== undefined) next.network.proxyUrl = url("代理地址", network.proxyUrl, ["http:", "https:", "socks:", "socks5:"]);
  }

  const java = section("java");
  if (java) {
    if (java.autoInstall !== undefined) next.java.autoInstall = bool("自动安装 Java", java.autoInstall);
    if (java.extraPaths !== undefined) {
      if (!Array.isArray(java.extraPaths) || java.extraPaths.length > 50) throw new SettingsError("Java 路径列表不正确");
      next.java.extraPaths = [...new Set(java.extraPaths.map((entry) => text("Java 路径", entry, 1000)).filter(Boolean))];
    }
  }

  const launch = section("launch");
  if (launch) {
    if (launch.memory !== undefined) next.launch.memory = launch.memory === "auto" ? "auto" : int("内存", launch.memory, 512, 262_144);
    if (launch.jvmPreset !== undefined) next.launch.jvmPreset = oneOf("JVM 预设", launch.jvmPreset, ["default", "mojang", "large-modpack", "zgc"] as const);
    if (launch.jvmArgs !== undefined) next.launch.jvmArgs = text("JVM 参数", launch.jvmArgs);
    if (launch.gameArgs !== undefined) next.launch.gameArgs = text("游戏参数", launch.gameArgs);
    if (launch.width !== undefined) next.launch.width = int("窗口宽度", launch.width, 0, 16384);
    if (launch.height !== undefined) next.launch.height = int("窗口高度", launch.height, 0, 16384);
    if (launch.fullscreen !== undefined) next.launch.fullscreen = bool("全屏", launch.fullscreen);
    if (launch.afterLaunch !== undefined) next.launch.afterLaunch = oneOf("启动后行为", launch.afterLaunch, ["keep", "minimize", "hide", "close"] as const);
    if (launch.versionType !== undefined) next.launch.versionType = text("版本类型标识", launch.versionType, 40) || "Vitrine";
  }

  const accounts = section("accounts");
  if (accounts) {
    if (accounts.msClientId !== undefined) {
      const id = text("Azure 应用 ID", accounts.msClientId, 100);
      if (id && !UUID.test(id)) throw new SettingsError("Azure 应用（客户端）ID 应当是形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx 的 GUID");
      next.accounts.msClientId = id;
    }
    if (accounts.curseforgeKey !== undefined) next.accounts.curseforgeKey = text("CurseForge API 密钥", accounts.curseforgeKey, 300);
    if (accounts.ownerUuid !== undefined) {
      const id = text("默认 UUID", accounts.ownerUuid, 60);
      if (id && !UUID.test(id)) throw new SettingsError("UUID 格式不正确，应为 32 位十六进制（可带连字符）");
      next.accounts.ownerUuid = id;
    }
  }

  const ui = section("ui");
  if (ui) {
    if (ui.motion !== undefined) next.ui.motion = oneOf("动效", ui.motion, ["auto", "full", "reduced"] as const);
    if (ui.fps !== undefined) next.ui.fps = oneOf("帧率上限", ui.fps, ["auto", 30, 60, 120] as const);
    if (ui.pauseWhenGameRuns !== undefined) next.ui.pauseWhenGameRuns = bool("游戏运行时暂停动画", ui.pauseWhenGameRuns);
    if (ui.releaseGpuWhenGameRuns !== undefined) next.ui.releaseGpuWhenGameRuns = bool("游戏运行时释放显存", ui.releaseGpuWhenGameRuns);
    if (ui.theme !== undefined) next.ui.theme = oneOf("界面配色", ui.theme, ["auto", "light", "dark"] as const);
    if (ui.whenUnfocused !== undefined) next.ui.whenUnfocused = oneOf("失去焦点时", ui.whenUnfocused, ["pause", "throttle", "full"] as const);
    if (ui.quality !== undefined) next.ui.quality = oneOf("画质", ui.quality, ["auto", "high", "medium", "low"] as const);
    if (ui.sounds !== undefined) next.ui.sounds = bool("音效", ui.sounds);
    if (ui.soundVolume !== undefined) next.ui.soundVolume = Math.min(1, Math.max(0, Number(ui.soundVolume) || 0));
    if (ui.splash !== undefined) next.ui.splash = oneOf("开屏动画", ui.splash, ["full", "short", "off"] as const);
    if (ui.scale !== undefined) next.ui.scale = Math.min(1.5, Math.max(0.75, Number(ui.scale) || 1));
  }
  return next;
}

/** Read stored settings, ignoring anything invalid field by field so one bad value never resets the rest. */
export function normalizeSettings(stored: unknown): Settings {
  let result = structuredClone(DEFAULT_SETTINGS);
  if (!isObject(stored)) return result;
  const attempt = (patch: unknown) => {
    try {
      result = applySettings(result, patch);
    } catch {
      /* skip this field */
    }
  };
  attempt({ gameRoot: stored.gameRoot });
  for (const key of ["sources", "download", "network", "java", "launch", "accounts", "ui"] as const) {
    const value = stored[key];
    if (!isObject(value)) continue;
    for (const [field, entry] of Object.entries(value)) attempt({ [key]: { [field]: entry } });
  }
  return result;
}

export class SettingsStore {
  private current: Settings = structuredClone(DEFAULT_SETTINGS);
  private listeners = new Set<(settings: Settings, previous: Settings) => void>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    const stored = await readJsonOr<unknown>(this.file, undefined);
    if (stored !== undefined && !isObject(stored)) await copyFile(this.file, `${this.file}.bad`).catch(() => {});
    this.current = normalizeSettings(stored);
    return this.get();
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  /** Cheap read for hot paths (the download engine reads these on every run). */
  peek(): Readonly<Settings> {
    return this.current;
  }

  onChange(listener: (settings: Settings, previous: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async update(patch: unknown): Promise<Settings> {
    const previous = this.current;
    const next = applySettings(previous, patch);
    this.current = next;
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, next)).catch(() => {});
    await this.writing;
    for (const listener of this.listeners) {
      try {
        listener(this.get(), previous);
      } catch {
        /* listeners must not break settings */
      }
    }
    return this.get();
  }
}
