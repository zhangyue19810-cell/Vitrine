import { copyFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exists, ensureDir, writeFileAtomic } from "../util/fsx";
import { getString, nbt, parseNbt, writeNbt, type NbtRoot, type NbtTag } from "./nbt";

export interface ServerEntry {
  name: string;
  /** host or host:port, as typed in the game. */
  ip: string;
  /** Base64 PNG (without the data: prefix), as the game stores it. */
  icon?: string;
  /** undefined = ask the player, true / false = decided. */
  acceptTextures?: boolean;
  hidden?: boolean;
}

function emptyRoot(): NbtRoot {
  return { name: "", tag: nbt.compound({ servers: nbt.list("compound") }) };
}

async function loadRoot(path: string): Promise<NbtRoot> {
  if (!(await exists(path))) return emptyRoot();
  return parseNbt(await readFile(path));
}

function serversList(root: NbtRoot): NbtTag[] {
  if (root.tag.type !== "compound") throw new Error("servers.dat 格式不正确");
  const list = root.tag.value.get("servers");
  if (!list) {
    const created = nbt.list("compound");
    root.tag.value.set("servers", created);
    return (created as Extract<NbtTag, { type: "list" }>).value;
  }
  if (list.type !== "list") throw new Error("servers.dat 里的 servers 不是列表");
  return list.value;
}

function toEntry(tag: NbtTag): ServerEntry | undefined {
  if (tag.type !== "compound") return undefined;
  const accept = tag.value.get("acceptTextures");
  const hidden = tag.value.get("hidden");
  return {
    name: getString(tag, "name") ?? "",
    ip: getString(tag, "ip") ?? "",
    icon: getString(tag, "icon"),
    acceptTextures: accept && accept.type === "byte" ? accept.value !== 0 : undefined,
    hidden: hidden && hidden.type === "byte" ? hidden.value !== 0 : undefined,
  };
}

export async function readServers(path: string): Promise<ServerEntry[]> {
  const root = await loadRoot(path);
  return serversList(root).map(toEntry).filter((entry): entry is ServerEntry => Boolean(entry));
}

async function save(path: string, root: NbtRoot): Promise<void> {
  await ensureDir(dirname(path));
  // The game itself keeps the previous copy as servers.dat_old.
  if (await exists(path)) await copyFile(path, `${path}_old`).catch(() => {});
  await writeFileAtomic(path, writeNbt(root, "none"));
}

function applyEntry(compound: Extract<NbtTag, { type: "compound" }>, patch: Partial<ServerEntry>) {
  if (patch.name !== undefined) compound.value.set("name", nbt.string(patch.name));
  if (patch.ip !== undefined) compound.value.set("ip", nbt.string(patch.ip));
  if (patch.icon !== undefined) {
    if (patch.icon) compound.value.set("icon", nbt.string(patch.icon));
    else compound.value.delete("icon");
  }
  if ("acceptTextures" in patch) {
    if (patch.acceptTextures === undefined) compound.value.delete("acceptTextures");
    else compound.value.set("acceptTextures", nbt.byte(patch.acceptTextures ? 1 : 0));
  }
  if (patch.hidden !== undefined) compound.value.set("hidden", nbt.byte(patch.hidden ? 1 : 0));
}

/** Validate the address the way a person would type it into the game. */
export function validateServerAddress(ip: string): string | undefined {
  const text = ip.trim();
  if (!text) return "服务器地址不能为空";
  if (/\s/.test(text)) return "服务器地址不能包含空格";
  const match = /^(\[[0-9a-fA-F:]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return "服务器地址格式不正确（应为 主机 或 主机:端口）";
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return "端口必须在 1 到 65535 之间";
  return undefined;
}

export async function addServer(path: string, entry: ServerEntry): Promise<number> {
  const problem = validateServerAddress(entry.ip);
  if (problem) throw new Error(problem);
  const root = await loadRoot(path);
  const list = serversList(root);
  const compound = nbt.compound() as Extract<NbtTag, { type: "compound" }>;
  applyEntry(compound, { ...entry, ip: entry.ip.trim(), name: entry.name.trim() || entry.ip.trim() });
  list.push(compound);
  await save(path, root);
  return list.length - 1;
}

export async function updateServer(path: string, index: number, patch: Partial<ServerEntry>): Promise<void> {
  if (patch.ip !== undefined) {
    const problem = validateServerAddress(patch.ip);
    if (problem) throw new Error(problem);
  }
  const root = await loadRoot(path);
  const target = serversList(root)[index];
  if (!target || target.type !== "compound") throw new Error("没有这个服务器");
  applyEntry(target, { ...patch, ip: patch.ip?.trim(), name: patch.name?.trim() });
  await save(path, root);
}

export async function removeServer(path: string, index: number): Promise<void> {
  const root = await loadRoot(path);
  const list = serversList(root);
  if (index < 0 || index >= list.length) throw new Error("没有这个服务器");
  list.splice(index, 1);
  await save(path, root);
}

export async function moveServer(path: string, from: number, to: number): Promise<void> {
  const root = await loadRoot(path);
  const list = serversList(root);
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) throw new Error("没有这个服务器");
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  await save(path, root);
}
