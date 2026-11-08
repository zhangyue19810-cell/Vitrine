import type { StageItem } from "../archive-stage";
import type { ArchiveRecord } from "../data";
import type { ActionPayload, InstancePayload, ProjectPayload } from "./faces";
import { formatCount, relativeTime } from "./format";
import { store } from "./store";
import type { ContentKind, ContentProject } from "./types";
import { lastPlayedText } from "./ui-bits";

/**
 * What the archives of the 3D stage are made of: the instances (and the "new / browse / import" actions) on the home ring,
 * and the online projects on the download row. Each item carries a plain payload that the face painter prints.
 */

export const KIND_LABEL: Record<ContentKind, string> = {
  mod: "模组",
  modpack: "整合包",
  resourcepack: "资源包",
  shader: "光影",
  datapack: "数据包",
};

/** A short, stable number for a payload: when it changes, the face is printed again. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Items of the home ring: one archive per record of the shelf, in the shelf's order (group by group, then the actions). */
export function ringItems(records: readonly ArchiveRecord[]): StageItem[] {
  return records.map((record): StageItem => {
    if (record.kind === "action") {
      const payload: ActionPayload = { kind: "action", title: record.title, subtitle: record.subtitle, badge: record.badge };
      return { key: record.id, revision: hash(JSON.stringify(payload)), payload };
    }
    const instance = store.instance(record.id);
    const running = Boolean(instance && (instance.running || store.gameOf(instance.id)));
    const facts: string[] = [];
    if (instance) {
      facts.push(lastPlayedText(instance));
      if (instance.modCount > 0) facts.push(`${instance.modCount} 个模组`);
      if (instance.javaMajor) facts.push(`Java ${instance.javaMajor}`);
      if (!instance.valid) facts.push(instance.problem ?? "无法读取");
      else if (instance.incomplete) facts.push("文件不完整，可以在右侧“修复文件”");
      const note = instance.config.note?.trim();
      if (note) facts.push(note);
    }
    const payload: InstancePayload = {
      kind: "instance",
      title: record.title,
      subtitle: record.subtitle,
      badge: record.badge,
      number: record.number,
      favorite: Boolean(record.favorite),
      running,
      facts,
    };
    return { key: record.id, revision: hash(JSON.stringify(payload)), payload };
  });
}

const SIDE_WORD: Record<string, string> = { required: "必需", optional: "可选", unsupported: "不支持" };

function sidesOf(project: ContentProject): string[] {
  if (project.kind !== "mod") return [];
  const out: string[] = [];
  if (project.clientSide && SIDE_WORD[project.clientSide]) out.push(`客户端 ${SIDE_WORD[project.clientSide]}`);
  if (project.serverSide && SIDE_WORD[project.serverSide]) out.push(`服务端 ${SIDE_WORD[project.serverSide]}`);
  return out;
}

/**
 * An online project as an archive. `icon` is undefined until it has been fetched, null when there is none (the face then
 * prints the project's first letter), or the decoded image.
 */
export function projectItem(project: ContentProject, icon: CanvasImageSource | null | undefined, summary = project.summary): StageItem {
  const payload: ProjectPayload = {
    kind: "project",
    title: project.title,
    author: project.author ?? "",
    summary: (summary ?? "").trim(),
    downloads: formatCount(project.downloads),
    updated: project.updatedAt ? relativeTime(Date.parse(project.updatedAt)) : "",
    categories: project.categories,
    kindLabel: KIND_LABEL[project.kind],
    source: project.source === "modrinth" ? "Modrinth" : "CurseForge",
    sides: sidesOf(project),
    icon,
    installLabel: project.kind === "modpack" ? "安装为新实例" : "安装",
  };
  // The revision covers every printed field: a late icon and a late Chinese summary both repaint the archive.
  const revision = hash(JSON.stringify({ ...payload, icon: icon === undefined ? 0 : icon === null ? 1 : 2 }));
  return { key: `${project.source}:${project.id}`, revision, payload };
}

/** Blank archives that stand in while the first results of a search are on their way. */
export function placeholderItems(kind: ContentKind, count = 10): StageItem[] {
  return Array.from({ length: count }, (_, index): StageItem => {
    const payload: ProjectPayload = {
      kind: "project",
      title: "正在加载…",
      author: "",
      summary: "",
      downloads: "—",
      updated: "",
      categories: [],
      kindLabel: KIND_LABEL[kind],
      source: "",
      sides: [],
      icon: null,
      installLabel: "安装",
    };
    return { key: `placeholder:${kind}:${index}`, revision: 0, payload };
  });
}
