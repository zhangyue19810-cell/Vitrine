import { basename } from "node:path";
import { ZipReader, type ZipEntry } from "../util/zip";
import { parseCurseForgeManifest } from "./cf-pack";
import { parseMcbbsPack } from "./mcbbs";
import { MRPACK_INDEX, parseMrpackIndex } from "./mrpack";
import { parseMultiMcPack } from "./multimc";
import { PackError, type PackFormat, type PackManifest } from "./types";

const MAX_MANIFEST = 64 * 1024 * 1024;

export interface OpenedPack {
  zip: ZipReader;
  format: PackFormat;
  manifest: PackManifest;
  close(): void;
}

function findEntry(zip: ZipReader, name: string): ZipEntry | undefined {
  const exact = zip.get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return zip.find((entry) => !entry.isDirectory && entry.name.toLowerCase() === lower);
}

async function readJsonEntry(zip: ZipReader, entry: ZipEntry): Promise<unknown> {
  const text = (await zip.read(entry, MAX_MANIFEST)).toString("utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PackError(`${entry.name} 不是有效的 JSON：${(error as Error).message}`);
  }
}

/** Look at the archive's entries and decide which pack format it is, without parsing it fully. */
export async function detectPackFormat(zip: ZipReader): Promise<{ format: PackFormat; entry: ZipEntry; root: string } | undefined> {
  const index = findEntry(zip, MRPACK_INDEX);
  if (index) return { format: "mrpack", entry: index, root: "" };
  const mcbbs = findEntry(zip, "mcbbs.packmeta");
  if (mcbbs) return { format: "mcbbs", entry: mcbbs, root: "" };
  const manifest = findEntry(zip, "manifest.json");
  if (manifest) {
    try {
      const json = (await readJsonEntry(zip, manifest)) as { manifestType?: string; minecraft?: unknown };
      if (json && (json.manifestType === "minecraftModpack" || json.minecraft)) return { format: "curseforge", entry: manifest, root: "" };
    } catch {
      /* not a pack manifest */
    }
  }
  const mmc = zip.find((entry) => !entry.isDirectory && /^(?:[^/]+\/)?mmc-pack\.json$/i.test(entry.name));
  if (mmc) return { format: "multimc", entry: mmc, root: mmc.name.slice(0, mmc.name.length - "mmc-pack.json".length) };
  return undefined;
}

/** Open an archive and parse its manifest. The caller closes the result. */
export async function openPack(file: string, options: { allowHosts?: string[] } = {}): Promise<OpenedPack> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(file);
  } catch (error) {
    throw new PackError(`无法打开整合包文件（不是有效的压缩包）：${(error as Error).message}`, "unknown-format");
  }
  try {
    const detected = await detectPackFormat(zip);
    if (!detected) throw new PackError("无法识别的整合包格式。支持 Modrinth（.mrpack）、CurseForge、MultiMC / Prism 和 MCBBS 格式。", "unknown-format");
    const json = await readJsonEntry(zip, detected.entry);
    let manifest: PackManifest;
    switch (detected.format) {
      case "mrpack":
        manifest = parseMrpackIndex(json, options);
        break;
      case "curseforge":
        manifest = parseCurseForgeManifest(json);
        break;
      case "mcbbs":
        manifest = parseMcbbsPack(json);
        break;
      case "multimc": {
        const cfgEntry = findEntry(zip, `${detected.root}instance.cfg`);
        const cfg = cfgEntry ? (await zip.read(cfgEntry, 1024 * 1024)).toString("utf8") : undefined;
        const dotted = `${detected.root}.minecraft/`;
        const plain = `${detected.root}minecraft/`;
        const gameDirPrefix = zip.entries.some((entry) => entry.name.startsWith(dotted)) ? dotted : zip.entries.some((entry) => entry.name.startsWith(plain)) ? plain : undefined;
        manifest = parseMultiMcPack({ pack: json, cfg, gameDirPrefix, fallbackName: detected.root ? detected.root.replace(/\/$/, "") : basename(file).replace(/\.[^.]+$/, "") });
        break;
      }
    }
    return { zip, format: detected.format, manifest, close: () => zip.close() };
  } catch (error) {
    zip.close();
    throw error;
  }
}
