import { $, $$, html, setHtml } from "../dom";
import { loaderLabel } from "../format";
import { openDialog } from "../modal";
import { displayName, primaryLoader, subtitleOf } from "../records";
import { store } from "../store";
import { instanceInitial, lastPlayedText } from "../ui-bits";
import type { InstanceSummary } from "../types";

/**
 * Quick search over the installed instances (and a few commands). It opens on `/` or Ctrl+K; the favourites list is the
 * same dialog filtered to starred instances.
 */

export type PickMode = "select" | "launch" | "manage";

interface Command {
  id: string;
  label: string;
  hint: string;
  words: string;
  run(): void | Promise<void>;
}

const commands = (onBrowse?: () => void): Command[] => [
  { id: "create", label: "新建实例", hint: "N", words: "新建 创建 安装 new create install", run: async () => (await import("./create")).openCreate({}) },
  { id: "browse", label: "浏览整合包 / 模组", hint: "", words: "浏览 整合包 模组 搜索 modrinth curseforge browse mods modpack", run: async () => (onBrowse ? onBrowse() : (await import("./browse")).openBrowse({ kind: "modpack" })) },
  { id: "import", label: "导入整合包文件", hint: "", words: "导入 整合包 mrpack zip import", run: async () => (await import("../actions")).importPack() },
  { id: "downloads", label: "下载与任务", hint: "D", words: "下载 任务 进度 downloads tasks", run: async () => (await import("./downloads")).openDownloads() },
  { id: "accounts", label: "账号管理", hint: "", words: "账号 登录 微软 离线 account login", run: async () => (await import("./accounts")).openAccounts() },
  { id: "settings", label: "设置", hint: "Ctrl ,", words: "设置 选项 settings options", run: async () => (await import("./settings")).openSettings() },
];

function haystack(instance: InstanceSummary): string {
  const loader = primaryLoader(instance);
  return [displayName(instance), instance.name, instance.mcVersion ?? "", loader ? `${loader.kind} ${loaderLabel(loader.kind)} ${loader.version ?? ""}` : "vanilla 原版", instance.config.group ?? "", instance.config.note ?? "", instance.config.modpack?.name ?? ""].join(" ").toLowerCase();
}

function rank(instance: InstanceSummary, tokens: string[]): number {
  const text = haystack(instance);
  if (!tokens.every((token) => text.includes(token))) return -1;
  const name = displayName(instance).toLowerCase();
  let score = 1;
  for (const token of tokens) {
    if (name.startsWith(token)) score += 6;
    else if (name.includes(token)) score += 3;
  }
  if (instance.config.favorite) score += 1;
  return score;
}

export function openSearch(options: { favorites?: boolean; query?: string; onPick(id: string, mode: PickMode): void; onBrowse?(): void }) {
  const body = document.createElement("div");
  body.innerHTML = `<div class="search-input" style="margin-bottom:10px"><input class="input" data-q autocomplete="off" spellcheck="false" placeholder="${options.favorites ? "在收藏里搜索…" : "搜索实例、版本、加载器…（Enter 选中 · Ctrl+Enter 启动）"}" aria-label="搜索" role="combobox" aria-expanded="true" aria-controls="search-list" /></div><div class="search-results" id="search-list" role="listbox"></div>`;
  const dialog = openDialog({ eyebrow: options.favorites ? "FAVORITES" : "SEARCH", title: options.favorites ? "收藏的实例" : "搜索", body, size: "wide", buttons: [] });
  const input = $<HTMLInputElement>("[data-q]", body);
  const results = $<HTMLElement>(".search-results", body);
  input.value = options.query ?? "";
  let active = 0;
  let found: ({ type: "instance"; instance: InstanceSummary } | { type: "command"; command: Command })[] = [];

  const paint = () => {
    const tokens = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const pool = store.instances.filter((instance) => !options.favorites || instance.config.favorite);
    const instances = tokens.length
      ? pool
          .map((instance) => ({ instance, score: rank(instance, tokens) }))
          .filter((entry) => entry.score >= 0)
          .sort((a, b) => b.score - a.score || (b.instance.config.lastPlayed ?? 0) - (a.instance.config.lastPlayed ?? 0))
          .map((entry) => entry.instance)
      : [...pool].sort((a, b) => Number(Boolean(b.config.favorite)) - Number(Boolean(a.config.favorite)) || (b.config.lastPlayed ?? 0) - (a.config.lastPlayed ?? 0));
    const cmds = options.favorites ? [] : commands(options.onBrowse).filter((command) => !tokens.length || tokens.every((token) => `${command.label} ${command.words}`.toLowerCase().includes(token)));
    found = [...instances.slice(0, 40).map((instance) => ({ type: "instance" as const, instance })), ...(tokens.length || !instances.length ? cmds : cmds.slice(0, 3)).map((command) => ({ type: "command" as const, command }))];
    active = Math.min(active, Math.max(0, found.length - 1));
    if (!found.length) {
      return setHtml(results, html`<div class="empty"><b>${options.favorites ? "还没有收藏的实例" : "没有找到匹配的内容"}</b><div>${options.favorites ? "在首页或管理页点 ☆，实例就会出现在这里。" : "试试版本号（1.21.1）、加载器（neoforge）或实例名称的一部分。"}</div></div>`);
    }
    let divided = false;
    setHtml(
      results,
      html`<div class="list">${found.map((entry, index) => {
        if (entry.type === "instance") {
          const { instance } = entry;
          const running = Boolean(store.gameOf(instance.id));
          return html`<button class="item" role="option" data-i="${index}" aria-selected="${index === active}" data-selected="${index === active}" style="width:100%;text-align:left"><span class="thumb">${instanceInitial(instance)}</span><div style="min-width:0"><div class="title">${instance.config.favorite ? "★ " : ""}${displayName(instance)}</div><div class="sub">${subtitleOf(instance)} · ${lastPlayedText(instance)}</div></div><div class="tail">${running ? html`<span class="chip accent">运行中</span>` : ""}${instance.modCount ? html`<span class="chip">${instance.modCount} 模组</span>` : ""}</div></button>`;
        }
        const head = !divided ? html`<div class="micro" style="padding:14px 4px 6px">命令</div>` : "";
        divided = true;
        return html`${head}<button class="item" role="option" data-i="${index}" aria-selected="${index === active}" data-selected="${index === active}" style="width:100%;text-align:left"><span class="thumb">›</span><div style="min-width:0"><div class="title">${entry.command.label}</div></div><div class="tail muted" style="font-size:11px">${entry.command.hint}</div></button>`;
      })}</div>`,
    );
  };

  const move = (delta: number) => {
    if (!found.length) return;
    active = (active + delta + found.length) % found.length;
    for (const row of $$("[data-i]", results)) {
      const on = Number(row.dataset.i) === active;
      row.setAttribute("aria-selected", String(on));
      row.dataset.selected = String(on);
      if (on) row.scrollIntoView({ block: "nearest" });
    }
  };

  const choose = (index: number, mode: PickMode) => {
    const entry = found[index];
    if (!entry) return;
    dialog.close();
    if (entry.type === "instance") options.onPick(entry.instance.id, mode);
    else void entry.command.run();
  };

  input.addEventListener("input", () => {
    active = 0;
    paint();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active, event.ctrlKey || event.metaKey ? "launch" : event.shiftKey ? "manage" : "select");
    }
  });
  results.addEventListener("click", (event) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-i]");
    if (row) choose(Number(row.dataset.i), "select");
  });
  results.addEventListener("pointermove", (event) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-i]");
    const index = row ? Number(row.dataset.i) : -1;
    if (index >= 0 && index !== active) {
      active = index;
      for (const other of $$("[data-i]", results)) {
        const on = Number(other.dataset.i) === active;
        other.setAttribute("aria-selected", String(on));
        other.dataset.selected = String(on);
      }
    }
  });
  paint();
  queueMicrotask(() => input.focus({ preventScroll: true }));
}
