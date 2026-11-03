import { createRollingNumber, createRollingText } from "@kitlangton/rolling-number";
import { records } from "../data";
import { $, $$, html, setHtml } from "./dom";
import { avatar, instanceChips, lastPlayedText, shelfPosition } from "./ui-bits";
import { displayName } from "./records";
import { store } from "./store";
import { formatSpeed } from "./format";
import { PRODUCT, brandHeading, markSvg } from "../brand";

/**
 * The home screen's overlay: brand, navigation, the description of the selected instance, the counters and the footer.
 * It is built once; `update()` only touches what changed (text nodes, attributes), so selecting is cheap.
 */

type Rolling = ReturnType<typeof createRollingText>;
type RollingNumber = ReturnType<typeof createRollingNumber>;

export const STAGE_TEMPLATE = `
  <div class="three-scene" id="three-scene"></div>
  <div class="scene-atmosphere"></div>
  <svg id="inspection-marks" viewBox="0 0 1352 760" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
  <div id="inspection-text" aria-hidden="true"><span></span><strong></strong></div>

  <div class="drag-strip" aria-hidden="true"></div>
  <header class="brand" aria-label="${PRODUCT.name}"><span class="brand-mark">${markSvg({ label: PRODUCT.name })}</span><div class="brand-text">${brandHeading}</div></header>
  <nav class="system-nav" id="nav" aria-label="主导航"></nav>

  <div class="home" id="home"></div>
  <div class="detail" id="detail"></div>
  <div class="hover-label" id="hover-label" aria-hidden="true"></div>

  <footer class="system-footer" id="footer"></footer>

  <div class="modal-root" id="modal-root"></div>
  <div id="launch-root"></div>
  <div class="toast-root" id="toast-root" aria-live="polite"></div>
  <div class="drag-veil" id="drag-veil">松开以导入整合包 / 世界</div>
  <div id="splash-root"></div>
`;

const HOME_TEMPLATE = `
  <section class="callout" data-kind="instance" id="callout">
    <div class="callout-eyebrow"><span data-f="lane"></span><span class="slash">/</span><span data-f="eyebrow"></span></div>
    <h2 class="callout-title"><button data-act="open-selected" aria-label="打开所选实例"><span data-f="title"></span><span class="arrow" aria-hidden="true">↗</span></button></h2>
    <div class="callout-rule"></div>
    <div class="callout-summary"><span data-f="subtitle"></span><span class="side" data-f="side"></span></div>
    <div class="callout-meta" data-f="meta"></div>
    <div class="callout-note" data-f="note"></div>
    <div class="callout-actions" data-f="actions"></div>
  </section>
  <section class="counter" aria-label="序号">
    <div class="label">INSTANCE / SELECT</div>
    <div class="value"><b data-f="counter"></b><i data-f="total"></i></div>
  </section>
  <div class="ticks">
    <button class="arrow-btn" data-act="step-file" data-dir="up" data-step="-1" aria-label="上一个实例">↑</button>
    <div class="marks" data-f="marks" aria-hidden="true"></div>
    <button class="arrow-btn" data-act="step-file" data-dir="down" data-step="1" aria-label="下一个实例">↓</button>
  </div>
  <div class="lane-nav">
    <button class="arrow-btn" data-act="step-lane" data-dir="prev" data-step="-1" aria-label="上一个分组">←</button>
    <div class="name"><small data-f="lane-label"></small><b data-f="lane-name"></b></div>
    <button class="arrow-btn" data-act="step-lane" data-dir="next" data-step="1" aria-label="下一个分组">→</button>
  </div>
  <div class="hint"><kbd>↑</kbd><kbd>↓</kbd> 切换实例 <kbd>←</kbd><kbd>→</kbd> 切换分组 <kbd>Enter</kbd> 启动 <kbd>Space</kbd> 管理 <kbd>/</kbd> 搜索</div>
`;

const FOOTER_TEMPLATE = `
  <span><i class="status-light" data-f="light"></i><span data-f="core"></span></span>
  <span data-f="net"></span>
  <span class="push"><button data-act="open-about" title="关于">${PRODUCT.name.toUpperCase()} ${PRODUCT.nameCn} ↗</button></span>
`;

export class HomeView {
  private readonly nav = $("#nav");
  private readonly home = $("#home");
  private readonly footer = $("#footer");
  private rollTitle!: Rolling;
  private rollLane!: Rolling;
  private rollCounter!: RollingNumber;
  private rollTotal!: RollingNumber;
  private shown = { id: "", signature: "" };
  private field = new Map<string, HTMLElement>();
  animated = true;

  constructor() {
    this.home.innerHTML = HOME_TEMPLATE;
    this.footer.innerHTML = FOOTER_TEMPLATE;
    for (const element of [...$$("[data-f]", this.home), ...$$("[data-f]", this.footer)]) this.field.set(element.dataset.f!, element);
    const options = { duration: 460, motionBlur: true, transition: "direct" as const, stagger: "none" as const, animated: false };
    this.rollTitle = createRollingText(this.f("title"), { ...options, text: "" });
    this.rollLane = createRollingText(this.f("lane-name"), { ...options, text: "" });
    const numberOptions = { duration: 460, motionBlur: true, animated: false, locales: "en-US", format: { minimumIntegerDigits: 2, useGrouping: false } };
    this.rollCounter = createRollingNumber(this.f("counter"), { ...numberOptions, value: 0 });
    this.rollTotal = createRollingNumber(this.f("total"), { ...numberOptions, value: 0 });
    this.renderNav();
    this.renderFooter();
  }

  private f(name: string): HTMLElement {
    const element = this.field.get(name);
    if (!element) throw new Error(`missing home field ${name}`);
    return element;
  }

  private text(name: string, value: string) {
    const element = this.f(name);
    if (element.textContent !== value) element.textContent = value;
  }

  /** Everything that depends on the selection. `direction` tells the rolling digits which way to roll. */
  update(index: number, direction: "up" | "down" | "auto" = "auto") {
    const info = shelfPosition(index);
    const { record } = info;
    const instance = record.kind === "instance" ? store.instance(record.id) : undefined;
    const game = instance ? store.gameOf(instance.id) : undefined;
    const launching = instance ? store.activeTasks().some((task) => task.kind === "launch" && task.instanceId === instance.id) : false;
    const animated = this.animated;

    const callout = $("#callout");
    callout.dataset.kind = record.kind;

    this.text("lane", info.laneName);
    this.text("eyebrow", record.kind === "instance" ? `实例 ${String(record.number).padStart(2, "0")}` : "快速开始");
    this.rollTitle.update({ text: record.title, animated: animated && this.shown.id !== "" && this.shown.id !== record.id, direction: direction === "down" ? "down" : "up" });
    this.text("subtitle", record.subtitle);
    this.text("side", instance ? lastPlayedText(instance) : "");

    const signature = JSON.stringify([record.id, instance?.modifiedAt, instance?.running, instance?.incomplete, instance?.valid, instance?.config.favorite, instance?.modCount, instance?.config.note, game?.id, game?.state, launching]);
    if (signature !== this.shown.signature) {
      setHtml(this.f("meta"), instance ? instanceChips(instance, Boolean(game)) : html``);
      const note = instance?.config.note?.trim() ?? "";
      this.text("note", instance && !instance.valid ? (instance.problem ?? "") : note);
      setHtml(this.f("actions"), this.actions(record, instance, Boolean(game), launching));
      this.shown.signature = signature;
    }
    this.shown.id = record.id;

    const total = records.filter((entry) => entry.kind === "instance").length;
    this.rollCounter.update({ value: record.kind === "instance" ? record.number : 0, animated, direction: direction === "down" ? "down" : "up" });
    this.rollTotal.update({ value: total, animated: false });

    // Ticks: at most seven marks for the instances of this lane.
    const marks = Math.min(info.size, 7);
    const active = info.size <= 7 ? info.position : Math.round((info.position / Math.max(1, info.size - 1)) * (marks - 1));
    const wanted = Array.from({ length: marks }, (_, i) => (i === active ? "1" : "0")).join("");
    const marksElement = this.f("marks");
    if (marksElement.dataset.state !== wanted) {
      marksElement.dataset.state = wanted;
      marksElement.innerHTML = [...wanted].map((on) => `<i data-on="${on === "1"}"></i>`).join("");
    }
    this.text("lane-label", `COLUMN ${String(info.lane + 1).padStart(2, "0")} / ${String(info.laneCount).padStart(2, "0")}`);
    this.rollLane.update({ text: info.laneName, animated: animated && direction === "auto" ? false : animated });
    const single = info.size < 2;
    for (const button of $$("[data-act='step-file']", this.home)) button.toggleAttribute("disabled", single);
    for (const button of $$("[data-act='step-lane']", this.home)) button.toggleAttribute("disabled", info.laneCount < 2);
  }

  finishRolling() {
    this.rollTitle.finish();
    this.rollLane.finish();
    this.rollCounter.finish();
  }

  private actions(record: (typeof records)[number], instance: ReturnType<typeof store.instance>, running: boolean, launching: boolean) {
    if (record.kind === "action") {
      const label = record.action === "create" ? "开始安装" : record.action === "browse" ? "去浏览" : "选择文件";
      return html`<button class="btn accent lg" data-act="open-selected">${label}<span class="arrow">→</span></button>`;
    }
    if (!instance) return html``;
    const favorite = instance.config.favorite;
    const star = html`<button class="btn icon soft" data-act="toggle-favorite" aria-pressed="${favorite ? "true" : "false"}" title="${favorite ? "取消收藏" : "收藏"}">${favorite ? "★" : "☆"}</button>`;
    if (running) {
      return html`<button class="btn danger lg" data-act="stop-game">结束游戏</button><button class="btn soft" data-act="open-logs">游戏日志</button><button class="btn soft" data-act="open-detail">管理 <span class="arrow">↗</span></button>${star}`;
    }
    if (launching) {
      return html`<button class="btn accent lg" data-act="show-launch">查看启动进度<span class="arrow">→</span></button><button class="btn soft" data-act="open-detail">管理 <span class="arrow">↗</span></button>${star}`;
    }
    if (!instance.valid) {
      return html`<button class="btn lg" disabled>无法启动</button><button class="btn soft" data-act="open-detail">管理 <span class="arrow">↗</span></button>${star}`;
    }
    if (instance.incomplete) {
      return html`<button class="btn accent lg" data-act="repair-instance">修复文件<span class="arrow">→</span></button><button class="btn soft" data-act="launch-selected">仍然启动</button><button class="btn soft" data-act="open-detail">管理 <span class="arrow">↗</span></button>${star}`;
    }
    return html`<button class="btn accent lg" data-act="launch-selected">启动游戏<span class="arrow">→</span></button><button class="btn soft" data-act="open-detail">管理 <span class="arrow">↗</span></button>${star}`;
  }

  // ------------------------------------------------------------------------------------------ navigation and footer

  renderNav(options: { windowControls?: boolean } = {}) {
    const favorites = store.instances.filter((entry) => entry.config.favorite).length;
    const downloads = store.activeDownloads();
    const speed = downloads.reduce((sum, task) => sum + (task.progress?.speed ?? 0), 0);
    const account = store.account;
    const signature = JSON.stringify([favorites, downloads.length, Math.round(speed / 51200), account?.id, account?.name, account?.skinUrl, options.windowControls]);
    if (this.nav.dataset.signature === signature) return;
    this.nav.dataset.signature = signature;
    this.nav.innerHTML = html`
      <button class="nav-button" data-act="open-search" title="搜索实例 (/)"><span class="glyph">⌕</span><span>搜索</span><span class="key">/</span></button>
      <button class="nav-button" data-act="open-favorites" title="收藏的实例"><span class="glyph">★</span><span>收藏</span><span class="count">${favorites}</span></button>
      <button class="nav-button" data-act="open-downloads" title="下载与任务 (D)"><span class="glyph">⇩</span><span>下载</span><span class="count">${downloads.length ? formatSpeed(speed) : ""}</span><i class="dot" data-busy="${downloads.length > 0}"></i></button>
      <button class="nav-button nav-account" data-act="open-accounts" title="账号">${avatar(account)}<span class="name">${account?.name ?? "添加账号"}</span></button>
      <button class="nav-button" data-act="open-settings" title="设置 (Ctrl+,)"><span class="glyph">⚙</span><span>设置</span></button>
      ${options.windowControls ? html`<div class="window-controls"><button data-act="win-minimize" aria-label="最小化">–</button><button data-act="win-maximize" aria-label="最大化">▢</button><button data-act="win-close" aria-label="关闭">✕</button></div>` : ""}`.value;
  }

  renderFooter() {
    const core = store.connected ? `核心已连接${store.coreVersion ? ` · v${store.coreVersion}` : ""}` : "正在连接核心…";
    this.text("core", core);
    const light = this.f("light");
    const state = !store.connected ? "off" : store.activeDownloads().length || store.launching ? "busy" : "ok";
    if (light.dataset.state !== state) light.dataset.state = state;
    const settings = store.ready ? store.settings : undefined;
    const policy = { "official-first": "官方源优先", "mirror-first": "镜像源优先", "official-only": "仅官方源", "mirror-only": "仅镜像源" }[settings?.sources.policy ?? "official-first"];
    this.text("net", settings ? `下载 ${policy} · ${settings.download.concurrency} 线程 × ${settings.download.segments} 分段` : "");
  }
}
