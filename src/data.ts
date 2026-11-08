/**
 * What the 3D scene shows: one archive per record, grouped into columns ("lanes"). Two datasets use the same shape:
 * the home screen's ring holds the instances (plus the "new / browse / import" archives); the array field that an
 * instance opens into holds that instance's mods, worlds, servers and packs (plus its action archives). The launcher
 * swaps the dataset when the view changes (see app/records.ts and app/items.ts); the scene and the loop arithmetic
 * only read it through the functions below, so the module keeps live bindings and never hands out a stale copy.
 */

/** Things an action archive can do. */
export type ArchiveAction =
  | "create"
  | "import"
  | "browse"
  | "launch"
  | "install-mods"
  | "mods-folder"
  | "advanced"
  | "logs"
  | "back";

/** The kind of thing an item archive stands for. */
export type ItemType = "mod" | "world" | "server" | "resourcepack" | "shaderpack";

/** The few facts that the hover card shows ("basic information"); the full details live in the item's own HUD. */
export interface ItemFacts {
  type: ItemType;
  /** One short line each: version · loader, size, state, … */
  lines: string[];
  /** "off" archives are drawn dimmer (a disabled mod, a pack that the game does not load). */
  state?: "on" | "off" | "warn";
}

export interface ArchiveRecord {
  /** Stable key: the instance id, `action:<name>` for action archives, `<type>:<path>` for items. */
  id: string;
  kind: "instance" | "action" | "item";
  title: string;
  /** Second line of the label and the callout, e.g. "1.21.1 · NeoForge". */
  subtitle: string;
  /** Column name. */
  category: string;
  /** Short badge printed on the label ("NEOFORGE", "NEW"). */
  badge: string;
  /** Three-digit running number on the label. */
  number: number;
  /** Tint / icon hint for the label (modpack, vanilla, modded, …). */
  tone: "vanilla" | "modded" | "pack" | "action" | "item";
  favorite?: boolean;
  /** Action archives: which action they trigger. */
  action?: ArchiveAction;
  /** Item archives: what the hover card shows. */
  facts?: ItemFacts;
  /** Image attached to the archive: a `data:image/...` URL (mod logo, world icon, server favicon, pack.png). */
  icon?: string;
}

export let records: ArchiveRecord[] = [{ id: "action:create", kind: "action", title: "—", subtitle: "", category: "—", badge: "", number: 1, tone: "action", action: "create" }];
export let archiveColumns: string[] = ["—"];

/** Replace the shelf's contents. Every column must hold at least one record. */
export function setArchive(next: { records: ArchiveRecord[]; columns: string[] }) {
  if (!next.records.length || !next.columns.length) throw new Error("the shelf needs at least one column with one record");
  for (const column of next.columns) if (!next.records.some((record) => record.category === column)) throw new Error(`column "${column}" is empty`);
  records = next.records;
  archiveColumns = next.columns;
  lanes = undefined;
}

/** Record indices per lane, built once per dataset: a mod list can hold hundreds of records and the loop arithmetic asks often. */
let lanes: number[][] | undefined;

export function columnFiles(lane: number): number[] {
  lanes ??= archiveColumns.map((column) => records.flatMap((record, index) => (record.category === column ? [index] : [])));
  return lanes[lane] ?? [];
}

export function fileLocation(index: number) {
  const lane = archiveColumns.indexOf(records[index].category);
  const row = 12 + columnFiles(lane).indexOf(index);
  return { lane, row, slot: lane * 32 + row };
}

export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / 32));
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
