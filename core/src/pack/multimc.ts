import { ORIGIN_SOURCE, PackError, type PackLoader, type PackManifest, type PackSettings } from "./types";

/** Parse the INI dialect of MultiMC / Prism `instance.cfg`. Quotes around values are removed. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const LOADER_UIDS: Record<string, PackLoader["kind"]> = {
  "net.minecraftforge": "forge",
  "net.neoforged": "neoforge",
  "net.fabricmc.fabric-loader": "fabric",
  "org.quiltmc.quilt-loader": "quilt",
};
const SILENT_UIDS = new Set(["net.minecraft", "net.fabricmc.intermediary", "org.quiltmc.hashed"]);

interface RawComponent {
  uid?: string;
  version?: string;
  cachedName?: string;
}

export interface MultiMcInput {
  pack: unknown;
  /** Contents of instance.cfg when the archive has one. */
  cfg?: string;
  /** Archive folder (with trailing slash) holding the game directory, e.g. "MyPack/.minecraft/". */
  gameDirPrefix?: string;
  fallbackName?: string;
}

export function parseMultiMcPack(input: MultiMcInput): PackManifest {
  const raw = input.pack as { components?: RawComponent[] } | undefined;
  if (!raw || !Array.isArray(raw.components)) throw new PackError("mmc-pack.json 缺少 components 列表");
  const cfg = input.cfg ? parseIni(input.cfg) : {};

  const warnings: string[] = [];
  let mcVersion: string | undefined;
  const loaders: PackLoader[] = [];
  for (const component of raw.components) {
    const uid = component.uid ?? "";
    if (uid === "net.minecraft") mcVersion = component.version;
    else if (LOADER_UIDS[uid] && component.version) loaders.push({ kind: LOADER_UIDS[uid], version: component.version });
    else if (uid === "org.lwjgl" || uid === "org.lwjgl3") warnings.push(`自定义 LWJGL（${component.version ?? "?"}）不会被应用，将使用游戏自带的版本`);
    else if (!SILENT_UIDS.has(uid)) warnings.push(`未处理的组件：${component.cachedName ?? uid}${component.version ? ` ${component.version}` : ""}`);
  }
  if (!mcVersion) throw new PackError("整合包没有声明 Minecraft 版本");
  if (loaders.length > 1) warnings.push(`声明了多个加载器（${loaders.map((l) => l.kind).join("、")}），只会安装 ${loaders[0].kind}`);
  if (!input.gameDirPrefix) warnings.push("压缩包里没有 .minecraft 文件夹，只会安装游戏和加载器");

  const settings: PackSettings = {};
  if (cfg.OverrideMemory === "true" && Number(cfg.MaxMemAlloc) > 0) settings.memoryMb = Number(cfg.MaxMemAlloc);
  if (cfg.OverrideJavaArgs === "true" && cfg.JvmArgs) settings.jvmArgs = cfg.JvmArgs;
  if (cfg.OverrideWindow === "true") {
    if (Number(cfg.MinecraftWinWidth) > 0) settings.width = Number(cfg.MinecraftWinWidth);
    if (Number(cfg.MinecraftWinHeight) > 0) settings.height = Number(cfg.MinecraftWinHeight);
  }

  const name = (cfg.name || input.fallbackName || "MultiMC 整合包").trim();
  return {
    format: "multimc",
    name,
    mcVersion,
    loader: loaders[0],
    files: [],
    overrides: input.gameDirPrefix ? [input.gameDirPrefix] : [],
    warnings,
    settings: Object.keys(settings).length ? settings : undefined,
    summary: cfg.notes || undefined,
    origin: { source: ORIGIN_SOURCE.multimc, name },
  };
}
