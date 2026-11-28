import { records } from "../data";
import { $, $$, html, setHtml } from "./dom";
import { avatar, instanceChips, lastPlayedText, shelfPosition } from "./ui-bits";
import { displayName } from "./records";
import { store } from "./store";
import { formatSpeed } from "./format";
import { PRODUCT, brandHeading, markSvg } from "../brand";
import { currentSpringForce, springElement, springNumber } from "./spring-ui";

/**
 * The home screen's overlay: brand, navigation, the description of the selected instance and the footer.
 * It is built once; `update()` only touches what changed (text nodes, attributes), so selecting is cheap.
 */

export const STAGE_TEMPLATE = `
  <div class="three-scene" id="three-scene"></div>
  <div class="scene-aura" aria-hidden="true"></div>
  <div class="scene-atmosphere"></div>
  <svg id="inspection-marks" viewBox="0 0 1352 760" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
  <div id="inspection-text" aria-hidden="true"><span></span><strong></strong></div>

  <div class="drag-strip" aria-hidden="true"></div>
  <header class="brand" aria-label="${PRODUCT.name}"><span class="brand-mark">${markSvg({ label: PRODUCT.name, tight: true })}</span><div class="brand-text">${brandHeading}</div></header>
  <nav class="system-nav" id="nav" aria-label="主导航"></nav>
  <nav class="view-tabs" id="view-tabs" aria-label="视图"></nav>

  <div class="home" id="home"></div>
  <section class="download" id="download" aria-label="下载"></section>
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
  <section class="counter" aria-label="实例序号">
    <div class="label">INSTANCE / SELECT</div>
    <div class="value"><b data-f="counter">00</b><i data-f="total">00</i></div>
  </section>
  <div class="ticks" aria-label="实例导航">
    <button class="arrow-btn" data-act="step-file" data-dir="up" data-step="-1" aria-label="上一个实例">↑</button>
    <div class="marks" data-f="marks" aria-hidden="true"></div>
    <button class="arrow-btn" data-act="step-file" data-dir="down" data-step="1" aria-label="下一个实例">↓</button>
  </div>
  <div class="lane-nav" aria-label="分组导航">
    <button class="arrow-btn" data-act="step-lane" data-dir="prev" data-step="-1" aria-label="上一个分组">←</button>
    <div class="name"><small data-f="lane-label">COLUMN 01 / 01</small><b data-f="lane-name"></b></div>
    <button class="arrow-btn" data-act="step-lane" data-dir="next" data-step="1" aria-label="下一个分组">→</button>
  </div>
  <div class="hint"><span class="hint-ring"><kbd>←</kbd><kbd>→</kbd> 转动环 <kbd>PgUp</kbd><kbd>PgDn</kbd> 切换分组 </span><span class="hint-grid"><kbd>↑</kbd><kbd>↓</kbd> 切换实例 <kbd>←</kbd><kbd>→</kbd> 切换分组 </span><kbd>Enter</kbd> 启动 <kbd>Space</kbd> 管理 <kbd>/</kbd> 搜索</div>
`;

const FOOTER_TEMPLATE = `
  <span><i class="status-light" data-f="light" data-state="off"></i><span data-f="core">正在连接核心…</span></span>
  <span class="footer-net" data-f="net"></span>
  <span class="push"><button data-act="open-about" title="关于">${PRODUCT.name.toUpperCase()} ${PRODUCT.nameCn} ↗</button></span>
`;

export class HomeView {
  private readonly nav = $("#nav");
  private readonly home = $("#home");
  private readonly footer = $("#footer");
  private navCloseTimer?: ReturnType<typeof setTimeout>;
  private navMotion = 0;
  private shown = { id: "", signature: "" };
  private field = new Map<string, HTMLElement>();
  animated = true;

  constructor() {
    this.home.innerHTML = HOME_TEMPLATE;
    this.footer.innerHTML = FOOTER_TEMPLATE;
    for (const element of [...$$("[data-f]", this.home), ...$$("[data-f]", this.footer)]) this.field.set(element.dataset.f!, element);
    this.wireNav();
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

    const changed = this.shown.id !== "" && this.shown.id !== record.id;
    const title = this.f("title");
    this.text("lane", info.laneName);
    this.text("eyebrow", record.kind === "instance" ? `实例 ${String(record.number).padStart(2, "0")}` : "快速开始");
    if (title.textContent !== record.title) title.textContent = record.title;
    if (changed && animated) {
      void springElement(title, {
        fromY: direction === "down" ? -15 : 15,
        toY: 0,
        fromScale: 0.965,
        toScale: 1,
        fromOpacity: 0,
        toOpacity: 1,
        response: 0.34,
        dampingRatio: 0.8,
        force: currentSpringForce(),
      });
    }
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

    const total = records.filter((entry) => entry.kind === "instance").length;
    this.text("counter", record.kind === "instance" ? String(record.number).padStart(2, "0") : "00");
    this.text("total", String(total).padStart(2, "0"));
    this.text("lane-label", `COLUMN ${String(info.lane + 1).padStart(2, "0")} / ${String(info.laneCount).padStart(2, "0")}`);
    this.text("lane-name", info.laneName);
    if (changed && animated) {
      const counter = this.home.querySelector<HTMLElement>(".counter .value");
      if (counter) void springElement(counter, { fromY: 12, toY: 0, fromOpacity: 0, toOpacity: 1, response: 0.36, dampingRatio: 0.78, force: currentSpringForce() });
      const lane = this.home.querySelector<HTMLElement>(".lane-nav .name b");
      if (lane) void springElement(lane, { fromY: direction === "down" ? -10 : 10, toY: 0, fromOpacity: 0, toOpacity: 1, response: 0.34, dampingRatio: 0.8, force: currentSpringForce() });
    }

    const marksElement = this.f("marks");
    const marks = Math.min(info.size, 7);
    const active = info.size <= 7 ? info.position : Math.round((info.position / Math.max(1, info.size - 1)) * (marks - 1));
    if (marksElement.children.length !== marks) {
      marksElement.innerHTML = Array.from({ length: marks }, () => `<i data-on="false" style="--tick:.38;--tick-bg:0"></i>`).join("");
    }
    [...marksElement.children].forEach((mark, index) => {
      const element = mark as HTMLElement;
      const on = index === active;
      if (element.dataset.on === String(on)) return;
      element.dataset.on = String(on);
      const from = Number.parseFloat(element.style.getPropertyValue("--tick")) || (on ? 0.38 : 1);
      const to = on ? 1 : 0.38;
      void springNumber({
        from,
        to,
        response: 0.32,
        dampingRatio: 0.78,
        force: currentSpringForce(),
        onUpdate: (value) => {
          element.style.setProperty("--tick", value.toFixed(4));
          element.style.setProperty("--tick-bg", String(on ? Math.min(1, Math.max(0, value)) : Math.max(0, 1 - value)));
        },
      });
    });
    const single = info.size < 2;
    for (const button of $$("[data-act='step-file']", this.home)) button.toggleAttribute("disabled", single);
    for (const button of $$("[data-act='step-lane']", this.home)) button.toggleAttribute("disabled", info.laneCount < 2);
    this.shown.id = record.id;
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
    const first = downloads[0];
    const progress = first?.fraction !== undefined ? `${Math.round(first.fraction * 100)}%` : "";
    const taskProgress = downloads.map((task) => `${task.id}:${task.stage ?? ""}:${Math.round((task.fraction ?? 0) * 1000)}:${Math.round((task.progress?.speed ?? 0) / 1024)}`).join("|");
    const account = store.account;
    const signature = JSON.stringify([favorites, downloads.length, taskProgress, account?.id, account?.name, account?.skinUrl, options.windowControls]);
    if (this.nav.dataset.signature === signature) return;
    this.nav.dataset.signature = signature;
    this.nav.innerHTML = html`
      <button class="nav-button nav-account nav-master" data-act="open-accounts" title="账号与导航 · 悬停展开" aria-expanded="${this.nav.classList.contains("is-open") ? "true" : "false"}" aria-controls="nav-reveal">${avatar(account)}<span class="name">${account?.name ?? "添加账号"}</span><span class="nav-master-chevron" aria-hidden="true">⌄</span></button>
      <div class="nav-reveal" id="nav-reveal">
        <button class="nav-button" data-act="open-search" title="搜索实例 (/)"><span class="glyph">⌕</span><span>搜索</span><span class="key">/</span></button>
        <button class="nav-button" data-act="open-favorites" title="收藏的实例"><span class="glyph">★</span><span>收藏</span><span class="count">${favorites}</span></button>
        <button class="nav-button" data-act="open-downloads" title="${first?.stageLabel ?? "下载与任务"}${first?.progress ? ` · ${formatSpeed(first.progress.speed)}` : ""} (D)"><span class="glyph">⇩</span><span>下载</span><span class="count">${downloads.length ? `${progress ? `${progress} · ` : ""}${formatSpeed(speed)}` : ""}</span><i class="dot" data-busy="${downloads.length > 0}"></i></button>
        <button class="nav-button" data-act="open-custom-download" title="从网址下载文件"><span class="glyph">↧</span><span>自定义下载</span></button>
        <button class="nav-button" data-act="open-settings" title="设置 (Ctrl+,)"><span class="glyph">⚙</span><span>设置</span></button>
      </div>
      ${options.windowControls ? html`<div class="window-controls"><button data-act="win-minimize" aria-label="最小化">–</button><button data-act="win-maximize" aria-label="最大化">▢</button><button data-act="win-close" aria-label="关闭">✕</button></div>` : ""}`.value;
  }

  private wireNav() {
    const setOpen = (open: boolean) => this.setNavOpen(open);
    const keepOpen = () => {
      clearTimeout(this.navCloseTimer);
      setOpen(true);
    };
    const closeSoon = () => {
      clearTimeout(this.navCloseTimer);
      const wait = 90;
      this.navCloseTimer = setTimeout(() => {
        if (this.nav.matches(":hover") || this.nav.contains(document.activeElement)) return;
        setOpen(false);
      }, wait);
    };
    this.nav.addEventListener("pointerover", (event) => {
      if ((event.target as Element | null)?.closest(".nav-master")) keepOpen();
    });
    this.nav.addEventListener("pointerleave", closeSoon);
    this.nav.addEventListener("focusin", (event) => {
      if ((event.target as Element | null)?.closest(".nav-master, .nav-reveal")) keepOpen();
    });
    this.nav.addEventListener("focusout", () => requestAnimationFrame(closeSoon));
    this.nav.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.nav.classList.contains("is-open")) return;
      event.preventDefault();
      clearTimeout(this.navCloseTimer);
      setOpen(false);
      this.nav.querySelector<HTMLElement>(".nav-master")?.focus({ preventScroll: true });
    });
    if (matchMedia("(hover: none) and (pointer: coarse)").matches) setOpen(true);
  }

  /** Expand/collapse the nav with width, opacity and button springs, never a CSS duration. */
  private setNavOpen(open: boolean) {
    const reveal = this.nav.querySelector<HTMLElement>(".nav-reveal");
    if (!reveal) return;
    const token = ++this.navMotion;
    const buttons = [...reveal.querySelectorAll<HTMLElement>(".nav-button")];
    const chevron = this.nav.querySelector<HTMLElement>(".nav-master-chevron");
    this.nav.querySelector<HTMLElement>(".nav-master")?.setAttribute("aria-expanded", String(open));
    if (chevron) {
      const target = open ? 180 : 0;
      const current = Number.parseFloat(this.nav.style.getPropertyValue("--nav-chevron-angle")) || 0;
      void springNumber({
        from: current,
        to: target,
        response: 0.36,
        dampingRatio: 0.76,
        force: currentSpringForce(),
        onUpdate: (value) => this.nav.style.setProperty("--nav-chevron-angle", `${value.toFixed(2)}deg`),
      });
    }
    if (open) {
      this.nav.classList.add("is-open");
      reveal.style.visibility = "visible";
      reveal.style.pointerEvents = "auto";
      void springElement(reveal, {
        fromX: 18,
        toX: 0,
        fromY: -6,
        toY: 0,
        fromOpacity: 0,
        toOpacity: 1,
        fromScale: 0.94,
        toScale: 1,
        response: 0.42,
        dampingRatio: 0.8,
        force: currentSpringForce(),
        transformOrigin: "100% 0%",
      });
      void springElement(buttons[0] ?? reveal, {
        fromX: 14,
        toX: 0,
        fromY: -2,
        toY: 0,
        fromOpacity: 0,
        toOpacity: 1,
        response: 0.34,
        dampingRatio: 0.82,
        delay: 30,
      });
      buttons.slice(1).forEach((button, index) => {
        void springElement(button, {
          fromX: 12,
          toX: 0,
          fromY: -2,
          toY: 0,
          fromOpacity: 0,
          toOpacity: 1,
          fromScale: 0.96,
          toScale: 1,
          response: 0.34,
          dampingRatio: 0.8,
          delay: 58 + index * 38,
        });
      });
    } else {
      void springElement(reveal, {
        fromX: 0,
        toX: 12,
        fromY: 0,
        toY: -5,
        fromOpacity: 1,
        toOpacity: 0,
        fromScale: 1,
        toScale: 0.96,
        response: 0.3,
        dampingRatio: 0.94,
        retainFinal: true,
      }).then(() => {
        if (token !== this.navMotion) return;
        this.nav.classList.remove("is-open");
        reveal.style.removeProperty("visibility");
        reveal.style.removeProperty("pointer-events");
        reveal.style.removeProperty("translate");
        reveal.style.removeProperty("scale");
        reveal.style.removeProperty("opacity");
        reveal.style.removeProperty("will-change");
        for (const button of buttons) {
          button.style.removeProperty("translate");
          button.style.removeProperty("scale");
          button.style.removeProperty("opacity");
          button.style.removeProperty("will-change");
        }
      });
    }
  }

  /** The quiet status line that belongs to the shelf, not to a modal. */
  renderFooter() {
    if (!store.ready) return;
    this.text("core", `核心已连接${store.coreVersion ? ` · v${store.coreVersion}` : ""}`);
    const light = this.f("light");
    const state = !store.connected ? "off" : store.activeDownloads().length || store.launching ? "busy" : "ok";
    if (light.dataset.state !== state) light.dataset.state = state;
    const settings = store.settings;
    const policy = { "official-first": "官方源优先", "mirror-first": "镜像源优先", "official-only": "仅官方源", "mirror-only": "仅镜像源" }[settings.sources.policy] ?? "官方源优先";
    this.text("net", `下载 ${policy} · ${settings.download.concurrency} 线程 × ${settings.download.segments} 分段`);
  }


}
