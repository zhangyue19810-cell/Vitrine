import { readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { exists, removeRecursive } from "../util/fsx";
import { withZip } from "../util/zip";
import { parseChatComponent } from "../net/mc-ping";
import { relaxJson } from "./local-mods";

/** Resource packs, shader packs and screenshots in an instance's game directory. */

export interface ResourcePackInfo {
  fileName: string;
  kind: "zip" | "folder";
  name: string;
  description: string;
  packFormat?: number;
  /** Listed in options.txt, so the game will load it. */
  enabled: boolean;
  size?: number;
  /** data: URL of pack.png. */
  icon?: string;
  /** Set when the pack cannot be read; the entry is still listed so the player can delete it. */
  problem?: string;
}

export interface ShaderPackInfo {
  fileName: string;
  kind: "zip" | "folder";
  size?: number;
  /** options: iris.properties / optifine's shaderpacks/<name>.txt exists. */
  hasSettings: boolean;
  /** The shaderpack looks valid (has a shaders/ folder). */
  valid: boolean;
}

export interface ScreenshotInfo {
  fileName: string;
  size: number;
  takenAt: number;
}

const PNG_PREFIX = "data:image/png;base64,";

/** Names of packs enabled in options.txt (`resourcePacks:["vanilla","file/Faithful.zip"]`). */
export async function readEnabledResourcePacks(gameDir: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(gameDir, "options.txt"), "utf8");
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith("resourcePacks:"));
    if (!line) return new Set();
    const list = JSON.parse(line.slice("resourcePacks:".length)) as unknown;
    return new Set((Array.isArray(list) ? list : []).filter((entry): entry is string => typeof entry === "string").map((entry) => entry.replace(/^file\//, "")));
  } catch {
    return new Set();
  }
}

function describe(value: unknown): string {
  return parseChatComponent(value)
    .map((segment) => segment.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMcmeta(text: string): { description: string; packFormat?: number } {
  const parsed = JSON.parse(relaxJson(text.replace(/^﻿/, ""))) as { pack?: { description?: unknown; pack_format?: unknown; min_format?: unknown } };
  const format = typeof parsed.pack?.pack_format === "number" ? parsed.pack.pack_format : typeof parsed.pack?.min_format === "number" ? parsed.pack.min_format : undefined;
  return { description: describe(parsed.pack?.description ?? ""), packFormat: format };
}

async function readPack(dir: string, entry: { name: string; isDirectory(): boolean }, withIcon: boolean, enabled: Set<string>): Promise<ResourcePackInfo> {
  const path = join(dir, entry.name);
  const folder = entry.isDirectory();
  const base: ResourcePackInfo = { fileName: entry.name, kind: folder ? "folder" : "zip", name: entry.name.replace(/\.zip$/i, ""), description: "", enabled: enabled.has(entry.name) };
  try {
    if (folder) {
      const meta = await readFile(join(path, "pack.mcmeta"), "utf8").catch(() => undefined);
      if (meta === undefined) base.problem = "缺少 pack.mcmeta，游戏不会把它当作资源包";
      else Object.assign(base, parseMcmeta(meta));
      if (withIcon) {
        const icon = await readFile(join(path, "pack.png")).catch(() => undefined);
        if (icon) base.icon = PNG_PREFIX + icon.toString("base64");
      }
    } else {
      base.size = (await stat(path)).size;
      await withZip(path, async (zip) => {
        if (!zip.has("pack.mcmeta")) base.problem = "缺少 pack.mcmeta，游戏不会把它当作资源包";
        else Object.assign(base, parseMcmeta((await zip.read("pack.mcmeta")).toString("utf8")));
        if (withIcon && zip.has("pack.png")) base.icon = PNG_PREFIX + (await zip.read("pack.png")).toString("base64");
      });
    }
  } catch (error) {
    base.problem = `无法读取：${(error as Error).message}`;
  }
  return base;
}

export async function listResourcePacks(gameDir: string, options: { icons?: boolean } = {}): Promise<ResourcePackInfo[]> {
  const dir = join(gameDir, "resourcepacks");
  const enabled = await readEnabledResourcePacks(gameDir);
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() || /\.zip$/i.test(entry.name));
  const packs = await Promise.all(entries.map((entry) => readPack(dir, entry, options.icons ?? false, enabled)));
  return packs.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

export async function listShaderPacks(gameDir: string): Promise<ShaderPackInfo[]> {
  const dir = join(gameDir, "shaderpacks");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = new Set(entries.map((entry) => entry.name));
  const out: ShaderPackInfo[] = [];
  for (const entry of entries) {
    const folder = entry.isDirectory();
    if (!folder && !/\.zip$/i.test(entry.name)) continue;
    const path = join(dir, entry.name);
    let valid = false;
    let size: number | undefined;
    try {
      if (folder) valid = await exists(join(path, "shaders"));
      else {
        size = (await stat(path)).size;
        valid = await withZip(path, async (zip) => zip.entries.some((item) => /^shaders\//.test(item.name) || /(^|\/)shaders\/[^/]/.test(item.name)));
      }
    } catch {
      valid = false;
    }
    out.push({ fileName: entry.name, kind: folder ? "folder" : "zip", size, valid, hasSettings: names.has(`${entry.name}.txt`) });
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

// ---------------------------------------------------------------------------------------------- screenshots

function plainName(name: string): void {
  if (!name || /[\\/\u0000]/.test(name) || name === "." || name === "..") throw new Error("文件名无效");
}

export async function listScreenshots(gameDir: string): Promise<ScreenshotInfo[]> {
  const dir = join(gameDir, "screenshots");
  const out: ScreenshotInfo[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.(png|jpe?g)$/i.test(entry.name)) continue;
    const info = await stat(join(dir, entry.name)).catch(() => undefined);
    if (info) out.push({ fileName: entry.name, size: info.size, takenAt: info.mtimeMs });
  }
  return out.sort((a, b) => b.takenAt - a.takenAt);
}

/** A screenshot as a data URL, for thumbnails. Oversized files are refused rather than flooding the UI channel. */
export async function readScreenshot(gameDir: string, fileName: string, maxBytes = 8 * 1024 * 1024): Promise<string | undefined> {
  plainName(fileName);
  const path = join(gameDir, "screenshots", fileName);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > maxBytes) return undefined;
  const mime = /\.jpe?g$/i.test(fileName) ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

// ---------------------------------------------------------------------------------------------- file actions

export type PackFolder = "resourcepacks" | "shaderpacks" | "screenshots";

export async function removePackFile(gameDir: string, folder: PackFolder, fileName: string): Promise<void> {
  plainName(fileName);
  const path = join(gameDir, folder, fileName);
  if (!(await exists(path))) throw new Error("文件不存在");
  await removeRecursive(path);
  if (folder === "shaderpacks") await removeRecursive(`${path}.txt`).catch(() => {});
}

/** Rename within the same folder (used to add a numeric prefix and so change resource pack order, etc.). */
export async function renamePackFile(gameDir: string, folder: PackFolder, fileName: string, newName: string): Promise<void> {
  plainName(fileName);
  plainName(newName);
  const target = join(gameDir, folder, newName);
  if (await exists(target)) throw new Error("已经存在同名文件");
  await rename(join(gameDir, folder, fileName), target);
}
