import type { ArchiveRecord } from "../data";
import { loaderLabel } from "./format";
import type { InstanceSummary } from "./types";

/** Names of the lanes every install has; custom groups (set per instance) follow them. */
export const LANE_PACK = "整合包";
export const LANE_MODDED = "模组";
export const LANE_VANILLA = "原版";
export const LANE_ACTIONS = "新建";
const DEFAULT_LANES = [LANE_PACK, LANE_MODDED, LANE_VANILLA];

export interface ShelfEntry {
  instance?: InstanceSummary;
}

export function displayName(instance: InstanceSummary): string {
  return instance.config.displayName || instance.name;
}

/** The loader that matters for an instance (the first real loader; OptiFine is only reported when it is alone). */
export function primaryLoader(instance: InstanceSummary): { kind: string; version?: string } | undefined {
  const real = instance.loaders.find((loader) => loader.kind !== "none" && loader.kind !== "optifine");
  return real ?? instance.loaders.find((loader) => loader.kind === "optifine");
}

export function laneOf(instance: InstanceSummary): string {
  const group = instance.config.group?.trim();
  if (group) return group.slice(0, 16);
  if (instance.config.modpack) return LANE_PACK;
  const loader = primaryLoader(instance);
  if (loader && loader.kind !== "optifine") return LANE_MODDED;
  return LANE_VANILLA;
}

export function subtitleOf(instance: InstanceSummary): string {
  const loader = primaryLoader(instance);
  const parts: string[] = [];
  if (instance.mcVersion) parts.push(instance.mcVersion);
  if (loader) parts.push(`${loaderLabel(loader.kind)}${loader.version ? ` ${loader.version}` : ""}`);
  if (!parts.length) parts.push(instance.valid ? "未识别的版本" : "无法读取");
  return parts.join(" · ");
}

export function badgeOf(instance: InstanceSummary): string {
  const loader = primaryLoader(instance);
  if (!instance.valid) return "BROKEN";
  if (instance.incomplete) return "INCOMPLETE";
  return loader ? loaderLabel(loader.kind).toUpperCase() : instance.kind === "snapshot" ? "SNAPSHOT" : "VANILLA";
}

const ACTIONS: { action: NonNullable<ArchiveRecord["action"]>; title: string; subtitle: string; badge: string }[] = [
  { action: "create", title: "＋ 新建实例", subtitle: "安装任意版本，可选 Fabric / Forge / NeoForge…", badge: "NEW" },
  { action: "browse", title: "⌕ 浏览整合包", subtitle: "Modrinth / CurseForge", badge: "BROWSE" },
  { action: "import", title: "⇩ 导入整合包", subtitle: ".mrpack · CurseForge · MultiMC · MCBBS", badge: "IMPORT" },
];

function sortKey(instance: InstanceSummary): [number, number, string] {
  return [instance.config.favorite ? 0 : 1, -(instance.config.lastPlayed ?? 0), displayName(instance).toLowerCase()];
}

/** Arrange the instances into lanes (columns of the 3D shelf) and add the column of action cassettes. */
export function buildArchive(instances: InstanceSummary[]): { records: ArchiveRecord[]; columns: string[] } {
  const lanes = new Map<string, InstanceSummary[]>();
  for (const instance of instances) {
    const lane = laneOf(instance);
    const list = lanes.get(lane) ?? [];
    list.push(instance);
    lanes.set(lane, list);
  }
  const custom = [...lanes.keys()].filter((name) => !DEFAULT_LANES.includes(name)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const order = [...DEFAULT_LANES.filter((name) => lanes.has(name)), ...custom];
  const records: ArchiveRecord[] = [];
  let number = 0;
  for (const lane of order) {
    const list = lanes.get(lane)!;
    list.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2], "zh-Hans-CN");
    });
    for (const instance of list) {
      number++;
      records.push({
        id: instance.id,
        kind: "instance",
        title: displayName(instance),
        subtitle: subtitleOf(instance),
        category: lane,
        badge: badgeOf(instance),
        number,
        tone: instance.config.modpack ? "pack" : primaryLoader(instance) ? "modded" : "vanilla",
        favorite: instance.config.favorite,
      });
    }
  }
  for (const entry of ACTIONS) {
    records.push({ id: `action:${entry.action}`, kind: "action", title: entry.title, subtitle: entry.subtitle, category: LANE_ACTIONS, badge: entry.badge, number: 0, tone: "action", action: entry.action });
  }
  return { records, columns: [...order, LANE_ACTIONS] };
}

/** Which record to keep selected after the list changed: the same id, else the neighbour that took its place. */
export function reselect(previous: { id: string; index: number } | undefined, records: ArchiveRecord[]): number {
  if (!previous) return 0;
  const same = records.findIndex((record) => record.id === previous.id);
  if (same >= 0) return same;
  return Math.min(previous.index, Math.max(0, records.length - 1));
}
