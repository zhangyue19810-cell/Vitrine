import { archiveColumns, records, columnFiles } from "../data";
import { html, raw, safeUrl, type Raw } from "./dom";
import { formatPlayTime, loaderLabel, relativeTime } from "./format";
import { displayName, primaryLoader } from "./records";
import type { InstanceSummary, PublicAccount } from "./types";

function displaySkinUrl(value: string | undefined): string {
  const safe = safeUrl(value);
  if (!safe) return "";
  try {
    const url = new URL(safe);
    if (url.protocol === "http:" && /(^|\.)minecraft\.net$/i.test(url.hostname)) url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
}

/** Small pieces of markup shared by several views. */

export const ACCOUNT_TYPE_LABEL: Record<string, string> = { microsoft: "微软", offline: "离线", authlib: "外置登录" };

/** The player's face, cut out of the skin texture (the 8×8 head plus the hat layer), or an initial when there is no skin. */
export function avatar(account: Pick<PublicAccount, "name" | "skinUrl"> | undefined, large = false): Raw {
  const cls = `avatar${large ? " lg" : ""}`;
  const skin = displaySkinUrl(account?.skinUrl);
  if (account && skin) {
    const url = `url(&quot;${skin.replace(/["()\\]/g, "")}&quot;)`;
    return raw(`<span class="${cls}" style="background-image:${url},${url};background-size:800%;background-position:14.2857% 14.2857%,71.4286% 14.2857%;background-color:var(--field)"></span>`);
  }
  const initial = (account?.name ?? "?").trim().slice(0, 1).toUpperCase() || "?";
  return html`<span class="${cls}">${initial}</span>`;
}

export function instanceInitial(instance: InstanceSummary): string {
  return displayName(instance).trim().slice(0, 1).toUpperCase() || "?";
}

export function instanceChips(instance: InstanceSummary, running = false): Raw {
  const chips: Raw[] = [];
  if (running) chips.push(html`<span class="chip accent"><i class="dot busy"></i>运行中</span>`);
  if (!instance.valid) chips.push(html`<span class="chip danger" title="${instance.problem ?? ""}">无法读取</span>`);
  else if (instance.incomplete) chips.push(html`<span class="chip warn">文件不完整</span>`);
  if (instance.modCount > 0) chips.push(html`<span class="chip">${instance.modCount} 个模组</span>`);
  if (instance.javaMajor) chips.push(html`<span class="chip">Java ${instance.javaMajor}</span>`);
  const pack = instance.config.modpack;
  if (pack) chips.push(html`<span class="chip">${pack.source === "modrinth" ? "Modrinth" : pack.source === "curseforge" ? "CurseForge" : "整合包"}${pack.version ? ` ${pack.version}` : ""}</span>`);
  chips.push(html`<span class="chip">${instance.isolated ? "独立目录" : "共享目录"}</span>`);
  return html`${chips}`;
}

export function lastPlayedText(instance: InstanceSummary): string {
  const { lastPlayed, playTimeMs } = instance.config;
  if (!lastPlayed) return "尚未启动";
  return `上次 ${relativeTime(lastPlayed)} · 累计 ${formatPlayTime(playTimeMs)}`;
}

export function loaderText(instance: InstanceSummary): string {
  const loader = primaryLoader(instance);
  return loader ? `${loaderLabel(loader.kind)}${loader.version ? ` ${loader.version}` : ""}` : "原版";
}

/** Position of a record inside its lane: { lane, laneCount, position, size }. */
export function shelfPosition(index: number) {
  const record = records[Math.max(0, Math.min(records.length - 1, index))];
  const lane = Math.max(0, archiveColumns.indexOf(record.category));
  const files = columnFiles(lane);
  return { record, lane, laneCount: archiveColumns.length, laneName: archiveColumns[lane] ?? "—", position: Math.max(0, files.indexOf(index)), size: files.length, files };
}

/** Choices for a heap size in MB (the setting stores "auto" or a number). A value that is not on the list is kept as an extra entry. */
export function memoryOptions(current: "auto" | number | undefined): [string | number, string][] {
  const presets = [1024, 2048, 3072, 4096, 5120, 6144, 8192, 10240, 12288, 14336, 16384, 20480, 24576, 32768];
  const options: [string | number, string][] = [["auto", "自动（按电脑和整合包估算）"]];
  const values = new Set(presets);
  if (typeof current === "number" && !values.has(current)) values.add(current);
  for (const mb of [...values].sort((a, b) => a - b)) {
    const gb = mb / 1024;
    options.push([mb, `${Number.isInteger(gb) ? gb : gb.toFixed(2).replace(/0+$/, "")} GB（${mb} MB）`]);
  }
  return options;
}
