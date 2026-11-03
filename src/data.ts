/**
 * What the 3D shelf shows: one cassette per instance, grouped into columns ("lanes"). The launcher rebuilds this
 * whenever the instance list changes (see app/records.ts); the scene and the loop arithmetic only read it through the
 * functions below, so the module keeps live bindings and never hands out a stale copy.
 */
export interface ArchiveRecord {
  /** Stable key: the instance id, or `action:<name>` for the always-present action cassettes. */
  id: string;
  kind: "instance" | "action";
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
  tone: "vanilla" | "modded" | "pack" | "action";
  favorite?: boolean;
  /** Action cassettes: which action they trigger. */
  action?: "create" | "import" | "browse";
}

export let records: ArchiveRecord[] = [{ id: "action:create", kind: "action", title: "—", subtitle: "", category: "—", badge: "", number: 1, tone: "action", action: "create" }];
export let archiveColumns: string[] = ["—"];

/** Replace the shelf's contents. Every column must hold at least one record. */
export function setArchive(next: { records: ArchiveRecord[]; columns: string[] }) {
  if (!next.records.length || !next.columns.length) throw new Error("the shelf needs at least one column with one record");
  for (const column of next.columns) if (!next.records.some((record) => record.category === column)) throw new Error(`column "${column}" is empty`);
  records = next.records;
  archiveColumns = next.columns;
}

export function columnFiles(lane: number) {
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === archiveColumns[lane])
    .map(({ index }) => index);
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
