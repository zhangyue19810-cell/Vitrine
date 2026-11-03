import { rpc } from "../api";
import { action, $, html, setHtml, type Raw } from "../dom";
import { deleteInstance, duplicateInstance, guard, launchInstance, pickPath, renameInstance, repairInstance, stopGame, toggleFavorite, openFolder } from "../actions";
import { errorMessage } from "../format";
import { openMenu } from "../menu";
import { confirmDialog, toast } from "../modal";
import { displayName } from "../records";
import { store } from "../store";
import { instanceChips, loaderText } from "../ui-bits";
import type { InstanceSummary } from "../types";
import type { TabContext, TabDefinition, TabHandle, TabId } from "./detail-types";
import { showLaunchFor } from "./launch";

/**
 * The instance page: the cassette stays on the left (the 3D scene frames it), this panel takes the right half.
 * Tabs load their own code and data when they are first opened, so entering the page is instant and a tab that is
 * never visited costs nothing.
 */

export const TABS: TabDefinition[] = [
  { id: "overview", label: "概览", load: () => import("./tab-overview") },
  { id: "mods", label: "模组", load: () => import("./tab-mods") },
  { id: "worlds", label: "存档", load: () => import("./tab-worlds") },
  { id: "servers", label: "服务器", load: () => import("./tab-servers") },
  { id: "resources", label: "资源", load: () => import("./tab-resources") },
  { id: "config", label: "设置", load: () => import("./tab-config") },
  { id: "logs", label: "日志", load: () => import("./tab-logs") },
];

const TEMPLATE = `
  <button class="back-button" data-act="back-home" aria-label="返回实例列表"><span class="arrow">←</span><span>返回</span></button>
  <section class="detail-panel" aria-label="实例管理">
    <header class="detail-head">
      <div class="titles"><div class="eyebrow" data-f="eyebrow"></div><h2 data-f="title"></h2><div class="sub" data-f="sub"></div></div>
      <div class="actions" data-f="actions"></div>
    </header>
    <div class="detail-rule"></div>
    <div class="detail-tabs" role="tablist" aria-label="管理内容" data-f="tabs"></div>
    <div class="detail-body" role="tabpanel" data-f="body" tabindex="-1"></div>
  </section>`;

let lastTab: TabId = "overview";
let active: DetailView | undefined;

export class DetailView {
  private instanceId?: string;
  private tab: TabId = "overview";
  private controller?: AbortController;
  private handle?: TabHandle;
  private readonly counts = new Map<TabId, number>();
  private readonly off: (() => void)[] = [];
  private shown = "";
  private mountToken = 0;
  /** The instance disappeared (deleted elsewhere): the owner should leave the page. */
  onGone?: () => void;

  constructor(private readonly root: HTMLElement) {
    active = this;
    root.addEventListener("click", (event) => {
      const tab = (event.target as Element).closest<HTMLElement>("[data-tab]");
      if (tab) this.show(tab.dataset.tab as TabId);
    });
    root.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (!target.matches("[data-tab]") || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
      event.preventDefault();
      const index = TABS.findIndex((tab) => tab.id === this.tab);
      const next = TABS[(index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length];
      this.show(next.id);
      root.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus({ preventScroll: true });
    });
  }

  get currentId() {
    return this.instanceId;
  }

  get open() {
    return this.instanceId !== undefined;
  }

  get instance(): InstanceSummary | undefined {
    return store.instance(this.instanceId);
  }

  /** Show the page for an instance. The tab of the last visit is kept unless one is asked for. */
  openFor(instanceId: string, tab?: TabId) {
    this.close();
    this.instanceId = instanceId;
    this.root.innerHTML = TEMPLATE;
    this.shown = "";
    this.counts.clear();
    this.off.push(
      store.on("instances", () => this.refresh()),
      store.on("games", () => this.refresh()),
      store.on("tasks", () => this.refresh()),
    );
    this.refresh();
    this.show(tab ?? lastTab);
  }

  close() {
    this.mountToken++;
    this.disposeTab();
    for (const off of this.off.splice(0)) off();
    this.instanceId = undefined;
    this.root.textContent = "";
  }

  /** Redraw the header (and tell the tab) after the instance or its game changed. */
  refresh() {
    const instance = this.instance;
    if (!instance) {
      if (this.instanceId) {
        const gone = this.onGone;
        this.close();
        gone?.();
      }
      return;
    }
    const game = store.gameOf(instance.id);
    const launching = store.activeTasks().some((task) => task.kind === "launch" && task.instanceId === instance.id);
    const signature = JSON.stringify([instance.name, instance.config.displayName, instance.config.favorite, instance.valid, instance.incomplete, instance.modCount, instance.running, game?.state, launching, instance.mcVersion, instance.loaders.length, [...this.counts]]);
    if (signature !== this.shown) {
      this.shown = signature;
      this.paintHeader(instance, Boolean(game), launching);
      this.paintTabs();
    }
    this.handle?.update?.();
  }

  show(tab: TabId) {
    if (!this.instanceId) return;
    if (!TABS.some((entry) => entry.id === tab)) tab = "overview";
    this.tab = tab;
    lastTab = tab;
    this.paintTabs();
    void this.mount(tab);
  }

  // ------------------------------------------------------------------------------------------ painting

  private f(name: string): HTMLElement {
    return $(`[data-f="${name}"]`, this.root);
  }

  private paintHeader(instance: InstanceSummary, running: boolean, launching: boolean) {
    this.f("eyebrow").textContent = `实例管理 / ${instance.config.modpack ? "整合包" : instance.loaders.some((l) => l.kind !== "none") ? "模组" : "原版"}`;
    this.f("title").textContent = displayName(instance);
    setHtml(this.f("sub"), html`${[instance.mcVersion ?? "未识别", loaderText(instance)].join(" · ")}`);
    const favorite = instance.config.favorite;
    let primary: Raw;
    if (running) primary = html`<button class="btn danger" data-act="detail-stop">结束游戏</button>`;
    else if (launching) primary = html`<button class="btn accent" data-act="detail-show-launch">启动进度 →</button>`;
    else if (!instance.valid) primary = html`<button class="btn" disabled>无法启动</button>`;
    else if (instance.incomplete) primary = html`<button class="btn accent" data-act="detail-repair">修复文件</button><button class="btn soft" data-act="detail-launch">仍然启动</button>`;
    else primary = html`<button class="btn accent" data-act="detail-launch">启动游戏 <span class="arrow">→</span></button>`;
    setHtml(
      this.f("actions"),
      html`${primary}<button class="btn icon soft" data-act="detail-favorite" aria-pressed="${favorite ? "true" : "false"}" title="${favorite ? "取消收藏" : "收藏"}">${favorite ? "★" : "☆"}</button><button class="btn icon soft" data-act="detail-more" aria-haspopup="menu" title="更多操作">⋯</button>`,
    );
  }

  private paintTabs() {
    const instance = this.instance;
    const tabs = this.f("tabs");
    const parts = TABS.map((tab) => {
      const count = tab.id === "mods" ? (this.counts.get("mods") ?? instance?.modCount) : this.counts.get(tab.id);
      return html`<button role="tab" id="tab-${tab.id}" data-tab="${tab.id}" aria-selected="${tab.id === this.tab ? "true" : "false"}" tabindex="${tab.id === this.tab ? 0 : -1}">${tab.label}${count ? html`<span class="count">${count}</span>` : ""}</button>`;
    });
    const markup = html`${parts}`.value;
    if (tabs.dataset.markup !== markup) {
      tabs.dataset.markup = markup;
      tabs.innerHTML = markup;
    }
    this.f("body").setAttribute("aria-labelledby", `tab-${this.tab}`);
  }

  // ------------------------------------------------------------------------------------------ tabs

  private disposeTab() {
    this.controller?.abort();
    this.controller = undefined;
    try {
      this.handle?.dispose?.();
    } catch (error) {
      console.error("tab dispose failed", error);
    }
    this.handle = undefined;
  }

  private async mount(tab: TabId) {
    this.disposeTab();
    const token = ++this.mountToken;
    const controller = new AbortController();
    this.controller = controller;
    const body = this.f("body");
    body.scrollTop = 0;
    body.textContent = "";
    const definition = TABS.find((entry) => entry.id === tab)!;
    const context: TabContext = {
      body,
      signal: controller.signal,
      instance: () => {
        const instance = this.instance;
        if (!instance) throw new Error("实例已不存在");
        return instance;
      },
      setCount: (count) => {
        if (count === undefined || count === 0) this.counts.delete(tab);
        else this.counts.set(tab, count);
        this.shown = "";
        this.refresh();
      },
      go: (next) => this.show(next),
    };
    try {
      const module = await definition.load();
      if (token !== this.mountToken) return;
      const handle = await module.mount(context);
      if (token !== this.mountToken) {
        handle?.dispose?.();
        return;
      }
      this.handle = handle ?? undefined;
    } catch (error) {
      if (token !== this.mountToken || controller.signal.aborted) return;
      console.error(`tab ${tab} failed`, error);
      setHtml(body, html`<div class="empty"><b>这一页没能打开</b><div>${errorMessage(error)}</div><div><button class="btn soft" data-act="detail-retry-tab">重试</button></div></div>`);
    }
  }

  retry() {
    void this.mount(this.tab);
  }
}

// ---------------------------------------------------------------------------------------------- actions

function current(): InstanceSummary | undefined {
  return active?.instance;
}

action("detail-launch", async () => {
  const instance = current();
  if (instance) await launchInstance(instance.id);
});
action("detail-stop", async () => {
  const instance = current();
  if (instance) await stopGame(instance.id);
});
action("detail-show-launch", () => {
  const instance = current();
  if (instance) showLaunchFor(instance.id);
});
action("detail-repair", async () => {
  const instance = current();
  if (instance) await repairInstance(instance.id);
});
action("detail-favorite", async () => {
  const instance = current();
  if (instance) await toggleFavorite(instance.id);
});
action("detail-retry-tab", () => active?.retry());

action("detail-more", async (button) => {
  const instance = current();
  if (!instance) return;
  const choice = await openMenu(button, [
    { id: "folder", label: "打开游戏文件夹" },
    { id: "rename", label: "修改显示名称" },
    { id: "duplicate", label: "复制实例" },
    { id: "script", label: "导出启动脚本", divider: true },
    { id: "pack", label: "导出为整合包" },
    { id: "verify", label: "完整校验并修复（较慢）", divider: true },
    { id: "delete", label: "删除实例", danger: true, divider: true },
  ]);
  if (!choice) return;
  switch (choice) {
    case "folder":
      return openFolder(instance.id);
    case "rename":
      return renameInstance(instance);
    case "duplicate":
      return duplicateInstance(instance);
    case "script":
      return exportScript(instance);
    case "pack":
      return (await import("./pack-export")).exportPack(instance);
    case "verify":
      return repairInstance(instance.id, "hash");
    case "delete":
      if (await deleteInstance(instance)) {
        toast(`已删除“${displayName(instance)}”`, "ok");
        active?.onGone?.();
      }
  }
});

async function exportScript(instance: InstanceSummary) {
  const account = store.account;
  const includeToken = account?.type === "microsoft" || account?.type === "authlib";
  const dest = await pickPath("save", { title: "导出启动脚本", defaultPath: `launch-${instance.name}.${store.system.os.name === "windows" ? "bat" : "sh"}`, filters: [{ name: "启动脚本", extensions: [store.system.os.name === "windows" ? "bat" : "sh"] }] });
  if (!dest) return;
  let withToken = false;
  if (includeToken) {
    withToken = await confirmDialog({
      eyebrow: "EXPORT SCRIPT",
      title: "在脚本里包含登录令牌吗？",
      message: html`<p style="margin:0;line-height:1.8">包含令牌的脚本可以直接用你的账号启动游戏，<b>任何拿到这个文件的人都能用它登录</b>，而且令牌会过期。<br />一般选“不包含”：脚本会改用离线名称启动，只适合单机或自己的服务器。</p>`,
      confirm: "包含令牌",
      cancel: "不包含",
      danger: true,
    });
  }
  const result = await guard(() => rpc("instances.exportScript", { id: instance.id, dest, includeToken: withToken }));
  if (!result) return;
  toast(`已导出：${result.path}`, "ok");
  for (const warning of result.warnings) toast(warning, "info", 7000);
}
