import { copyFile, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { copyDir, dirSize, ensureDir, exists, removeRecursive, writeFileAtomic } from "../util/fsx";
import { uniqueName } from "../mc/instances";
import { ZipReader, writeZip, type ZipSource } from "../util/zip";
import { throwIfAborted } from "../util/async";
import { getBigInt, getNumber, getString, getTag, nbt, parseNbt, writeNbt } from "./nbt";

export type GameType = "survival" | "creative" | "adventure" | "spectator";
export type Difficulty = "peaceful" | "easy" | "normal" | "hard";

export interface SaveInfo {
  folder: string;
  name: string;
  lastPlayed?: number;
  gameType?: GameType;
  hardcore?: boolean;
  cheats?: boolean;
  difficulty?: Difficulty;
  /** Minecraft version that last saved the world. */
  version?: string;
  dataVersion?: number;
  seed?: string;
  hasIcon: boolean;
  datapacks: string[];
  problem?: string;
}

const GAME_TYPES: GameType[] = ["survival", "creative", "adventure", "spectator"];
const DIFFICULTIES: Difficulty[] = ["peaceful", "easy", "normal", "hard"];

/** A save folder name must be one plain path segment. */
export function validateFolderName(name: string): string | undefined {
  if (!name || name !== name.trim()) return "名称不能为空或带首尾空格";
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || name === "." || name === ".." || name.endsWith(".")) return "名称包含不允许的字符";
  if (name.length > 100) return "名称太长";
  return undefined;
}

function saveDir(gameDir: string, folder: string): string {
  const problem = validateFolderName(folder);
  if (problem) throw new Error(`存档文件夹名无效：${problem}`);
  return join(gameDir, "saves", folder);
}

async function readLevelFile(dir: string) {
  for (const name of ["level.dat", "level.dat_old"]) {
    const path = join(dir, name);
    if (await exists(path)) return parseNbt(await readFile(path));
  }
  return undefined;
}

async function describe(gameDir: string, folder: string): Promise<SaveInfo | undefined> {
  const dir = saveDir(gameDir, folder);
  let level;
  let problem: string | undefined;
  try {
    level = await readLevelFile(dir);
  } catch (error) {
    problem = `level.dat 无法读取：${(error as Error).message}`;
  }
  if (!level && !problem) return undefined;
  const entries = await readdir(join(dir, "datapacks"), { withFileTypes: true }).catch(() => []);
  const base = { folder, hasIcon: await exists(join(dir, "icon.png")), datapacks: entries.filter((entry) => entry.isDirectory() || /\.zip$/i.test(entry.name)).map((entry) => entry.name).sort() };
  if (!level) return { ...base, name: folder, problem };
  const data = getTag(level.tag, "Data");
  const gameType = getNumber(data, "GameType");
  const difficulty = getNumber(data, "Difficulty");
  const seed = getBigInt(data, "WorldGenSettings.seed") ?? getBigInt(data, "RandomSeed");
  return {
    ...base,
    name: getString(data, "LevelName") ?? folder,
    lastPlayed: getNumber(data, "LastPlayed"),
    gameType: gameType !== undefined ? GAME_TYPES[gameType] : undefined,
    hardcore: getNumber(data, "hardcore") === undefined ? undefined : getNumber(data, "hardcore") !== 0,
    cheats: getNumber(data, "allowCommands") === undefined ? undefined : getNumber(data, "allowCommands") !== 0,
    difficulty: difficulty !== undefined ? DIFFICULTIES[difficulty] : undefined,
    version: getString(data, "Version.Name"),
    dataVersion: getNumber(data, "DataVersion"),
    seed: seed?.toString(),
  };
}

/** Worlds in `saves/`, most recently played first. Folders without a level.dat are not worlds. */
export async function listSaves(gameDir: string): Promise<SaveInfo[]> {
  const entries = await readdir(join(gameDir, "saves"), { withFileTypes: true }).catch(() => []);
  const out: SaveInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || validateFolderName(entry.name)) continue;
    const info = await describe(gameDir, entry.name);
    if (info) out.push(info);
  }
  return out.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.folder.localeCompare(b.folder));
}

export async function getSaveSize(gameDir: string, folder: string): Promise<number> {
  return dirSize(saveDir(gameDir, folder));
}

export async function readSaveIcon(gameDir: string, folder: string): Promise<string | undefined> {
  try {
    const data = await readFile(join(saveDir(gameDir, folder), "icon.png"));
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export async function deleteSave(gameDir: string, folder: string): Promise<void> {
  const dir = saveDir(gameDir, folder);
  if (!(await exists(join(dir, "level.dat"))) && !(await exists(join(dir, "level.dat_old")))) throw new Error("这个文件夹不是存档（没有 level.dat），为安全起见不会删除");
  await removeRecursive(dir);
}

export async function renameSaveFolder(gameDir: string, folder: string, newFolder: string): Promise<void> {
  const from = saveDir(gameDir, folder);
  const to = saveDir(gameDir, newFolder);
  if (await exists(to)) throw new Error(`已经存在名为“${newFolder}”的存档文件夹`);
  await rename(from, to);
}

/** Change the name shown in the world list (Data.LevelName), keeping the previous file as level.dat_old. */
export async function renameLevel(gameDir: string, folder: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("存档名称不能为空");
  const path = join(saveDir(gameDir, folder), "level.dat");
  const root = parseNbt(await readFile(path));
  const data = root.tag.type === "compound" ? root.tag.value.get("Data") : undefined;
  if (!data || data.type !== "compound") throw new Error("level.dat 格式不正确");
  data.value.set("LevelName", nbt.string(trimmed));
  await copyFile(path, `${path}_old`).catch(() => {});
  await writeFileAtomic(path, writeNbt(root, "gzip"));
}

export async function duplicateSave(gameDir: string, folder: string): Promise<string> {
  const from = saveDir(gameDir, folder);
  const taken = (await readdir(join(gameDir, "saves"))).map(String);
  const target = uniqueName(`${folder} 副本`, taken);
  await copyDir(from, join(gameDir, "saves", target), (relative) => relative !== "session.lock");
  return target;
}

async function walkFiles(root: string, rel: string, out: { rel: string; abs: string }[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name === "session.lock") continue;
    if (entry.isDirectory()) await walkFiles(root, next, out, signal);
    else if (entry.isFile()) out.push({ rel: next, abs: join(root, next) });
  }
}

/** Zip a world with its folder as the archive root, like the zips people share. */
export async function exportSave(gameDir: string, folder: string, dest: string, options: { signal?: AbortSignal; onEntry?: (done: number, total: number) => void } = {}): Promise<{ files: number; size: number }> {
  const dir = saveDir(gameDir, folder);
  const files: { rel: string; abs: string }[] = [];
  await walkFiles(dir, "", files, options.signal);
  const sources: ZipSource[] = files.map((file) => ({ name: `${folder}/${file.rel}`, file: file.abs, compress: !/\.(mca|mcc|png|ogg|zip|jar)$/i.test(file.rel) }));
  await writeZip(dest, sources, { signal: options.signal, onEntry: options.onEntry });
  return { files: files.length, size: (await stat(dest)).size };
}

/** Import a zipped world: the shallowest folder holding level.dat becomes the save. Returns the new folder name. */
export async function importSave(gameDir: string, zipPath: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  const zip = await ZipReader.open(zipPath);
  try {
    const levels = zip.entries.filter((entry) => !entry.isDirectory && /(^|\/)level\.dat$/.test(entry.name) && !entry.name.startsWith("__MACOSX/"));
    if (!levels.length) throw new Error("压缩包里没有找到 level.dat，这不是 Minecraft 存档");
    levels.sort((a, b) => a.name.split("/").length - b.name.split("/").length);
    const rootEntry = levels[0].name;
    const prefix = rootEntry.slice(0, rootEntry.length - "level.dat".length);
    const preferred = prefix ? basename(prefix.replace(/\/$/, "")) : basename(zipPath).replace(/\.[^.]+$/, "");
    const taken = (await readdir(join(gameDir, "saves")).catch(() => [] as string[])).map(String);
    const folder = uniqueName(validateFolderName(preferred) ? "导入的存档" : preferred, taken);
    const target = join(gameDir, "saves", folder);
    await ensureDir(target);
    try {
      await zip.extractTo(target, {
        signal: options.signal,
        map: (entry) => {
          if (!entry.name.startsWith(prefix) || entry.name.startsWith("__MACOSX/")) return undefined;
          const relative = entry.name.slice(prefix.length);
          return relative && !relative.endsWith("session.lock") ? relative : undefined;
        },
      });
    } catch (error) {
      await removeRecursive(target).catch(() => {});
      throw error;
    }
    return folder;
  } finally {
    zip.close();
  }
}
