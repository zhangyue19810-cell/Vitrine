import { wrap, type ArchiveNavigation } from "../archive-loop";
import { archiveColumns, columnFiles, fileLocation, records } from "../data";
import { InspectionOverlay } from "../inspection-overlay";
import { PRODUCT } from "../brand";
import { rpc, setBridge, tryRpc } from "./api";
import { createBridge, type Bridge } from "./bridge";
import { $, action, html, sleep } from "./dom";
import { guard, importPack, launchInstance, repairInstance, stopGame, toggleFavorite } from "./actions";
import { DownloadView } from "./download";
import { installDropZone } from "./dropzone";
import { HomeView, STAGE_TEMPLATE } from "./home";
import { Layout } from "./layout";
import { modals, toast, wireModals } from "./modal";
import { Perf, type PerfApp } from "./perf";
import { SceneHost, detectRendererName } from "./scene-host";
import { installShortcuts } from "./shortcuts";
import { sound } from "./sound";
import { showSplash, type Splash } from "./splash";
import { store } from "./store";
import { renderTabs, type ViewId } from "./tabs";
import { ThemeFader, paint, resolveDark, systemPrefersDark } from "./theme";
import type { Settings, TaskSnapshot } from "./types";
import { DetailView, TABS } from "./views/detail";
import { launchOverlay, showLaunchFor } from "./views/launch";

/**
 * The launcher itself: boots the interface (splash → core → shelf), owns the selection and the two modes (the shelf and an
 * instance's page), and wires the 3D scene to the render scheduler so that the animation pauses while a game is starting
 * or running and resumes when the window is focused again.
 */

type Mode = "archive" | "detail";
/** What the 3D stage shows in archive mode: the Möbius ring of the instances, or the single row of the download view. */
type View = "home" | "browse";

const cache = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`vitrine.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`vitrine.${key}`, value);
    } catch {
      /* private mode: the launcher simply forgets */
    }
  },
};

const CRASH_EXIT_GRACE_MS = 300;

export class App implements PerfApp {
  private readonly viewport = $("#viewport");
  private readonly stage = $("#stage");
  private layout!: Layout;
  private bridge?: Bridge;
  host!: SceneHost;
  private home!: HomeView;
  private detail!: DetailView;
  private perf!: Perf;
  private readonly fader = new ThemeFader();
  private inspection?: InspectionOverlay;

  private download!: DownloadView;
  private mode: Mode = "archive";
  private view: View = "home";
  private tab: ViewId = "home";
  private selected = 0;
  private readonly laneMemory = new Map<number, number>();
  private splashActive = true;
  private reduced = false;
  private dark = false;
  private hoverIndex: number | null = null;
  private pointer = { x: 0, y: 0 };
  private lastShade = -1;
  private overlayShown = false;
  private closeDetailTimer?: ReturnType<typeof setTimeout>;
  private readonly taskStates = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  // ------------------------------------------------------------------------------------------ PerfApp

  settings(): Settings | undefined {
    return store.ready ? store.settings : undefined;
  }
  gameRunning() {
    return store.gameRunning;
  }
  launching() {
    return store.launching;
  }
  covered() {
    return this.splashActive || modals.coversScene || launchOverlay.open;
  }
  reducedMotion() {
    return this.reduced;
  }

  draw(time: number) {
    const scene = this.host.scene;
    const amount = scene ? scene.themeAmount : this.fader.amount;
    paint(amount);
    this.fader.follow(amount);
    if (!scene) return;
    scene.update(time);
    const visibility = scene.detailVisibility;
    const shade = Math.round(visibility * 1000) / 1000;
    if (shade !== this.lastShade) {
      this.lastShade = shade;
      this.stage.style.setProperty("--detail-shade", String(shade));
    }
    // The old inspection lines belong to the plain shelf; the 3D stage prints its own information on the archives.
    if (!scene.stageActive && (this.mode === "detail" || visibility > 0.005 || this.overlayShown)) {
      this.inspection ??= new InspectionOverlay();
      this.inspection.render(scene.decryptionFrame, (x, y) => scene.projectCard(x, y), false, !this.reduced);
      this.overlayShown = this.mode === "detail" || visibility > 0.005;
    }
  }

  released() {
    this.stage.dataset.scene = "off";
    this.hoverIndex = null;
  }

  async restore() {
    const ok = await this.host.ensure();
    this.stage.dataset.scene = this.host.status;
    this.stage.dataset.ring = this.host.stage ? "on" : "off";
    if (!ok) return;
    this.host.present(true);
    this.perf.refresh();
  }

  // ------------------------------------------------------------------------------------------ boot

  async boot() {
    const stage = this.stage;
    stage.innerHTML = STAGE_TEMPLATE;
    document.title = `${PRODUCT.name} ${PRODUCT.nameCn}`;
    wireModals();
    this.layout = new Layout(this.viewport, stage);

    // The palette of the last run, before anything else is drawn: no flash of the wrong colours.
    const cachedDark = cache.get("dark");
    this.dark = cachedDark === null ? systemPrefersDark() : cachedDark === "1";
    this.fader.set(this.dark, true);

    this.bridge = createBridge();
    if (!this.bridge) return this.showNoBackend();
    setBridge(this.bridge);
    document.documentElement.dataset.shell = this.bridge.kind;

    this.home = new HomeView();
    this.home.renderNav({ windowControls: Boolean(this.bridge.window) });
    this.detail = new DetailView($("#detail"));
    this.detail.onGone = () => this.exitDetail();
    this.host = new SceneHost($("#three-scene"), {
      select: (index, cell) => this.onSceneSelect(index, cell),
      navigate: (axis, direction) => this.canBrowse() && (axis === "lane" ? this.stepLane(direction) : this.stepFile(direction)),
      hover: (index) => this.setHover(index),
    });
    this.host.stageHandlers = {
      select: (index) => this.onStageSelect(index),
      activate: () => this.onStageActivate(),
      action: (id, index) => this.download.handleAction(id, index),
      more: () => this.download.loadMore(),
    };
    this.download = new DownloadView(this.host, $("#download"), () => this.selectedInstance()?.id);
    this.stage.dataset.view = "home";
    this.renderTabs();
    this.host.setDark(this.dark, true);
    this.perf = new Perf(this, detectRendererName());
    this.registerActions();
    this.layout.onChange = () => {
      this.host.resize();
      // A resize clears the canvas; redraw once if the loop is not about to.
      if (!this.perf.running && this.host.ready && !this.covered()) this.perf.scheduler.renderNow();
    };
    this.updateInert();

    const style = (cache.get("splash") as "full" | "short" | "off" | null) ?? "full";
    const splash = style === "off" ? undefined : showSplash($("#splash-root"), style);
    const started = performance.now();

    try {
      splash?.status("正在连接核心…", 0.12);
      await this.connect(splash);
    } catch (error) {
      await splash?.finish();
      this.splashActive = false;
      return this.showCoreError(error);
    }
    splash?.status("正在布置展柜…", 0.5);
    this.applySettings(true);
    this.syncShelf(true);
    await this.host.ensure();
    this.stage.dataset.scene = this.host.status;
    this.stage.dataset.ring = this.host.stage ? "on" : "off";
    if (this.host.status === "failed") toast(`无法启动 3D 画面：${this.host.error ?? "未知原因"}。仍可以用键盘、右侧按钮和搜索操作。`, "error", 10_000);
    this.perf.sceneReady();
    splash?.status("准备就绪", 1);

    this.subscribe();
    this.wireInput();
    this.bridge.onWindowState?.((state) => this.perf.scheduler.setWindowState(state));
    this.perf.start();

    const wanted = style === "full" ? 2600 : style === "short" ? 900 : 0;
    await Promise.race([sleep(Math.max(0, wanted - (performance.now() - started))), splash?.skipped ?? Promise.resolve()]);
    this.splashActive = false;
    this.stage.dataset.booted = "true";
    this.updateInert();
    this.perf.refresh();
    this.host.present(true);
    await splash?.finish();
    this.exposeDebug();

    if (!store.instances.length) toast("先点“新建实例”安装一个版本，或把整合包文件拖进窗口导入。", "info", 9000);
    else if (!store.accounts.length) toast("右上角可以添加账号（微软 / 离线）。", "info", 6000);
  }

  private async connect(splash: Splash | undefined) {
    for (let attempt = 0; ; attempt++) {
      try {
        await store.bootstrap();
        return;
      } catch (error) {
        if (attempt >= 20) throw error;
        splash?.status(attempt < 3 ? "正在连接核心…" : "核心没有响应，仍在重试…", 0.12);
        await sleep(1000);
      }
    }
  }

  private showNoBackend() {
    this.stage.innerHTML = `<div class="boot-card"><div class="micro">NO BACKEND</div><h2>没有连接到核心</h2><p>这是界面开发预览。请先在项目目录运行 <code>npm run dev:backend</code>，再打开它打印出的带 <code>?backend=</code> 的链接。</p><p class="muted">正式版（桌面程序）里核心与界面一起启动，不会出现这个页面。</p></div>`;
  }

  private showCoreError(error: unknown) {
    this.stage.insertAdjacentHTML("beforeend", html`<div class="boot-card"><div class="micro">CORE UNREACHABLE</div><h2>核心没有响应</h2><p>${(error as Error)?.message ?? String(error)}</p><p><button class="btn accent" data-act="reload-page">重新加载</button></p></div>`.value);
    action("reload-page", () => location.reload());
  }

  // ------------------------------------------------------------------------------------------ settings

  private applySettings(first = false) {
    const ui = store.settings.ui;
    this.layout.setUiScale(ui.scale);
    this.reduced = ui.motion === "reduced" || (ui.motion === "auto" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.stage.classList.toggle("reduce-motion", this.reduced);
    this.host.setReducedMotion(this.reduced);
    this.home.animated = !this.reduced;
    sound.configure(ui.sounds, ui.soundVolume);
    cache.set("splash", ui.splash);
    this.perf.applyQuality();
    this.applyTheme(ui.theme, first);
    this.perf.refresh();
    this.later("footer", 0, () => this.home.renderFooter());
  }

  private applyTheme(setting: Settings["ui"]["theme"], immediate = false) {
    const dark = resolveDark(setting);
    if (dark === this.dark && !immediate) return;
    this.dark = dark;
    cache.set("dark", dark ? "1" : "0");
    // While the scene draws, its own wave drives the page palette; otherwise the page cross-fades by itself.
    const live = this.perf.running && this.host.ready;
    this.host.setDark(dark, immediate || !live);
    if (!live) this.fader.set(dark, immediate);
  }

  // ------------------------------------------------------------------------------------------ selection

  private canBrowse() {
    return this.mode === "archive" && !this.splashActive && !modals.open && !launchOverlay.open;
  }

  private onSceneSelect(index: number, cell?: { lane: number; row: number }) {
    if (!this.canBrowse()) return;
    // Clicking the cassette that is already selected opens it.
    if (index === this.selected) return this.openSelected();
    this.select(index, cell ? { cell } : undefined);
  }

  private select(index: number, navigation?: ArchiveNavigation, quiet = false) {
    const count = records.length;
    const next = ((index % count) + count) % count;
    const changed = next !== this.selected;
    this.selected = next;
    this.laneMemory.set(fileLocation(next).lane, next);
    this.host.select(next, navigation);
    const direction = navigation && "axis" in navigation ? (navigation.direction > 0 ? "up" : "down") : "auto";
    this.home.update(next, direction);
    const record = records[next];
    if (record.kind === "instance") cache.set("last", record.id);
    if (changed && !quiet) {
      const lane = navigation && "axis" in navigation && navigation.axis === "lane";
      sound.play(lane ? "column" : "tick", lane ? navigation.direction * 0.45 : 0);
    }
  }

  private stepFile(direction: number) {
    // The 3D ring has no columns: every step goes to the next archive round the loop.
    if (this.host.stage) return this.select(this.selected + direction, { axis: "row", direction });
    const files = columnFiles(fileLocation(this.selected).lane);
    if (files.length < 2) return;
    this.select(files[(files.indexOf(this.selected) + direction + files.length) % files.length], { axis: "row", direction });
  }

  private stepLane(direction: number) {
    const lane = fileLocation(this.selected).lane;
    const next = wrap(lane + direction, archiveColumns.length);
    const files = columnFiles(next);
    const remembered = this.laneMemory.get(next);
    this.select(remembered !== undefined && files.includes(remembered) ? remembered : files[0], { axis: "lane", direction });
  }

  /** Rebuild the shelf from the instance list, keeping the selection on the same instance. */
  private syncShelf(initial = false) {
    const current = records[this.selected];
    const last = cache.get("last");
    const previous = initial ? (last ? { id: last, index: 0 } : undefined) : current ? { id: current.id, index: this.selected } : undefined;
    this.selected = this.host.setInstances(store.instances, previous);
    this.laneMemory.clear();
    this.laneMemory.set(fileLocation(this.selected).lane, this.selected);
    this.home.update(this.selected, "auto");
    this.download?.refreshTargets();
  }

  private selectById(id: string) {
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    if (this.mode === "detail") this.exitDetail();
    this.select(index);
    if (this.view === "browse") this.showHome();
    return true;
  }

  private selectedInstance() {
    const record = records[this.selected];
    return record?.kind === "instance" ? store.instance(record.id) : undefined;
  }

  // ------------------------------------------------------------------------------------------ hover label

  private setHover(index: number | null) {
    const label = $("#hover-label");
    this.hoverIndex = index;
    if (index === null || !this.canBrowse()) {
      label.dataset.show = "false";
      return;
    }
    const record = records[index];
    if (!record) return;
    label.innerHTML = html`<b>${record.kind === "instance" ? String(record.number).padStart(2, "0") : "＋"}</b>${record.title}`.value;
    this.placeHover();
    label.dataset.show = "true";
  }

  private placeHover() {
    const label = $("#hover-label");
    const maxX = this.layout.state.width - label.offsetWidth - 12;
    const x = Math.max(8, Math.min(maxX, this.pointer.x + 16));
    label.style.transform = `translate(${x}px, ${this.pointer.y + 20}px)`;
  }

  // ------------------------------------------------------------------------------------------ views (ring ↔ download row)

  private renderTabs() {
    renderTabs($("#view-tabs"), this.tab);
  }

  private setView(view: View) {
    this.view = view;
    this.stage.dataset.view = view;
    this.setHover(null);
    this.updateInert();
    this.perf.refresh();
  }

  /** A tab was clicked: the ring regroups into the row (or the row swaps its category, or goes back to the ring). */
  private async showView(id: ViewId) {
    if (this.splashActive || modals.open || launchOverlay.open) return;
    if (this.mode === "detail") this.exitDetail();
    if (id === "home") return this.showHome();
    // Without WebGL the download view renders its DOM rail instead; it must not silently become the old modal sheet.
    this.tab = id;
    this.renderTabs();
    if (this.view === "browse") return void (await this.download.switchKind(id));
    this.setView("browse");
    sound.play("open");
    await this.download.enter(id);
  }

  private showHome() {
    this.tab = "home";
    this.renderTabs();
    if (this.view === "home") return;
    this.download.leave();
    this.setView("home");
    this.host.showRing();
    sound.play("close");
  }

  private onStageSelect(index: number) {
    if (this.splashActive) return;
    if (this.view === "browse") {
      this.download.onSelect(index);
      sound.play("tick", 0);
      return;
    }
    if (this.canBrowse()) this.select(index);
  }

  /** The selected archive of the ring was clicked again: open it (an instance's page, or the action it stands for). */
  private onStageActivate() {
    if (this.view === "home" && this.canBrowse()) this.openSelected();
  }

  // ------------------------------------------------------------------------------------------ modes

  private setMode(next: Mode) {
    if (this.mode === next) return;
    this.mode = next;
    this.stage.dataset.mode = next;
    this.host.setMode(next);
    this.setHover(null);
    clearTimeout(this.closeDetailTimer);
    if (next === "detail") {
      const record = records[this.selected];
      if (record?.kind === "instance") this.detail.openFor(record.id);
      sound.play("open");
    } else {
      // Keep the panel's contents until its fade-out is over.
      this.closeDetailTimer = setTimeout(() => this.mode === "archive" && this.detail.close(), 480);
      sound.play("close");
    }
    this.updateInert();
    this.perf.refresh();
  }

  private enterDetail() {
    if (records[this.selected]?.kind === "instance" && this.canBrowse()) this.setMode("detail");
  }

  private exitDetail() {
    this.setMode("archive");
  }

  private openSelected() {
    const record = records[this.selected];
    if (!record) return;
    if (record.kind === "instance") return this.enterDetail();
    void this.runRecordAction(record.action);
  }

  private async runRecordAction(kind: (typeof records)[number]["action"]) {
    if (kind === "create") return (await import("./views/create")).openCreate({});
    if (kind === "browse") return this.showView("modpack");
    if (kind === "import") return importPack();
  }

  private async launchSelected() {
    const instance = this.selectedInstance();
    if (!instance) return this.openSelected();
    if (!store.accounts.length) {
      toast("还没有账号：先添加一个微软账号或离线账号才能启动游戏。", "info", 6000);
      return (await import("./views/accounts")).openAccounts();
    }
    await launchInstance(instance.id);
  }

  /** Background layers cannot be reached by keyboard or pointer while something is in front of them. */
  private updateInert() {
    const front = this.splashActive || modals.open || launchOverlay.open;
    const set = (selector: string, inert: boolean) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) element.toggleAttribute("inert", inert);
    };
    set("#three-scene", front);
    set("#nav", front);
    set("#footer", front);
    set("#home", front || this.mode === "detail" || this.view === "browse");
    set("#download", front || this.mode === "detail" || this.view !== "browse");
    set("#view-tabs", front || this.mode === "detail");
    set("#detail", front || this.mode !== "detail");
  }

  // ------------------------------------------------------------------------------------------ events

  /** Run `job` once after `ms`, no matter how many times it is asked for in between. */
  private later(key: string, ms: number, job: () => void) {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        job();
      }, ms),
    );
  }

  private subscribe() {
    store.on("settings", () => this.applySettings());
    store.on("instances", () => {
      this.syncShelf();
      this.perf.refresh();
    });
    const refreshHome = () => {
      this.later("home", 120, () => {
        this.host.refreshRing();
        this.home.update(this.selected, "auto");
        this.home.renderNav({ windowControls: Boolean(this.bridge?.window) });
        this.home.renderFooter();
      });
    };
    store.on("games", () => {
      refreshHome();
      this.perf.refresh();
    });
    store.on("tasks", () => {
      refreshHome();
      this.perf.refresh();
    });
    store.on("accounts", refreshHome);
    store.on("connection", () => {
      refreshHome();
      if (store.connected) this.perf.resend();
    });
    store.on<TaskSnapshot>("task", (task) => this.onTask(task));
    store.on<string>("game-exit-ui", (gameId) => void this.onGameExit(gameId));
    modals.onChange(() => {
      this.updateInert();
      this.perf.refresh();
      this.setHover(null);
    });
    launchOverlay.onChange(() => {
      this.updateInert();
      this.perf.refresh();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme(store.settings.ui.theme));
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => this.applySettings());
  }

  /** Toasts and sounds when background work ends (launches have their own screen). */
  private onTask(task: TaskSnapshot) {
    const before = this.taskStates.get(task.id);
    if (before === task.state) return;
    this.taskStates.set(task.id, task.state);
    if (task.state === "running" && (before === "queued" || before === undefined) && (task.kind === "install" || task.kind === "modpack")) {
      void import("./views/downloads").then(({ openDownloads }) => openDownloads(task.id));
    }
    if (task.kind === "launch" || before === undefined && task.state !== "failed" && task.state !== "done") return;
    if (task.state === "done") {
      toast(`${task.title} 已完成`, "ok");
      sound.play("done");
    } else if (task.state === "failed") {
      toast(`${task.title} 失败：${task.error ?? "未知错误"}`, "error", 8000);
      sound.play("error");
    }
  }

  private async onGameExit(gameId: string) {
    let game = store.games.get(gameId);
    if (!game || game.state !== "exited") {
      await sleep(CRASH_EXIT_GRACE_MS);
      game = store.games.get(gameId);
    }
    if (!game) return;
    const crashed = !game.stoppedByUser && game.exitCode !== 0 && game.exitCode !== null && game.exitCode !== undefined;
    if (!crashed) {
      toast(`${game.instanceName} 已退出`, "info");
      return;
    }
    sound.play("error");
    toast(`${game.instanceName} 异常退出（退出码 ${game.exitCode}）`, "error", 8000);
    (await import("./views/logs")).openLogs(game.instanceId, { crash: true });
  }

  // ------------------------------------------------------------------------------------------ input

  private wireInput() {
    const scene = $("#three-scene");
    scene.addEventListener(
      "pointermove",
      (event) => {
        this.pointer = this.layout.toStage(event.clientX, event.clientY);
        if (this.hoverIndex !== null) this.placeHover();
      },
      { passive: true },
    );
    scene.addEventListener("pointerleave", () => this.setHover(null));
    window.addEventListener("blur", () => this.setHover(null));

    installShortcuts({
      mode: () => this.mode,
      view: () => this.view,
      ring: () => Boolean(this.host.stage),
      blocked: () => this.splashActive || modals.open || launchOverlay.open,
      stepFile: (d) => (this.view === "browse" ? this.download.step(d) : this.stepFile(d)),
      stepLane: (d) => (this.view === "browse" ? this.download.step(d) : this.stepLane(d)),
      launch: () => (this.view === "browse" ? this.download.installSelected() : void this.launchSelected()),
      open: () => (this.view === "browse" ? this.download.handleAction("page", this.host.stage?.selectedItem ?? 0) : this.openSelected()),
      back: () => (this.mode === "detail" ? this.exitDetail() : this.view === "browse" ? this.showHome() : undefined),
      search: () => (this.view === "browse" ? this.download.focusSearch() : this.openSearch(false)),
      settings: () => void import("./views/settings").then((m) => m.openSettings()),
      downloads: () => void import("./views/downloads").then((m) => m.openDownloads()),
      create: () => void this.runRecordAction("create"),
      tab: (index) => TABS[index] && this.detail.show(TABS[index].id),
    });

    if (this.bridge) {
      installDropZone({
        veil: $("#drag-veil"),
        bridge: this.bridge,
        enabled: () => !this.splashActive && !modals.open && !launchOverlay.open,
        onPaths: (paths) => void importPack(paths[0]),
        onNoPath: (names) => toast(names.length ? "网页预览拿不到文件路径，请点“导入整合包文件”并粘贴路径。" : "只能导入 .mrpack 或 .zip 整合包。", "info", 5000),
      });
    }
  }

  private openSearch(favorites: boolean) {
    void import("./views/search").then(({ openSearch }) =>
      openSearch({
        favorites,
        onPick: (id, how) => {
          if (!this.selectById(id)) return;
          if (how === "launch") void this.launchSelected();
          else if (how === "manage") setTimeout(() => this.enterDetail(), 60);
        },
        onBrowse: () => setTimeout(() => void this.showView("modpack"), 0),
      }),
    );
  }

  private registerActions() {
    const withInstance = (job: (id: string) => void | Promise<void>) => () => {
      const instance = this.selectedInstance();
      if (instance) return job(instance.id);
    };
    action("view-tab", (element) => void this.showView(element.dataset.view as ViewId));
    action("open-selected", () => this.openSelected());
    action("open-detail", () => this.enterDetail());
    action("back-home", () => this.exitDetail());
    action("step-file", (element) => this.stepFile(Number(element.dataset.step)));
    action("step-lane", (element) => this.stepLane(Number(element.dataset.step)));
    action("launch-selected", () => this.launchSelected());
    action("stop-game", withInstance((id) => stopGame(id)));
    action("show-launch", withInstance((id) => showLaunchFor(id)));
    action("repair-instance", withInstance((id) => repairInstance(id)));
    action("toggle-favorite", withInstance((id) => toggleFavorite(id)));
    action("open-logs", withInstance(async (id) => (await import("./views/logs")).openLogs(id)));
    action("open-search", () => this.openSearch(false));
    action("open-favorites", () => this.openSearch(true));
    action("open-downloads", async () => (await import("./views/downloads")).openDownloads());
    action("open-accounts", async () => (await import("./views/accounts")).openAccounts());
    action("open-settings", async () => (await import("./views/settings")).openSettings());
    action("open-settings-accounts", async () => (await import("./views/settings")).openSettings("accounts"));
    action("open-about", async () => (await import("./views/about")).openAbout());
    action("win-minimize", () => this.bridge?.window?.minimize());
    action("win-maximize", () => this.bridge?.window?.toggleMaximize());
    action("win-close", () => this.bridge?.window?.close());
  }

  // ------------------------------------------------------------------------------------------ debugging

  private exposeDebug() {
    if (!import.meta.env.DEV && !new URLSearchParams(location.search).has("debug")) return;
    (window as unknown as { __vitrine: unknown }).__vitrine = {
      app: this,
      host: this.host,
      download: this.download,
      perf: this.perf,
      store,
      layout: this.layout,
      /** Draw `count` frames right now, whatever the scheduler decided (screenshots, tests). */
      step: (count = 1) => {
        for (let i = 0; i < count; i++) this.perf.scheduler.renderNow();
      },
      stats: () => ({ ...this.perf.scheduler.stats(), scene: this.host.status, tier: this.host.tier, steps: this.perf.steps }),
      rpc,
      tryRpc,
      guard,
    };
  }
}

export async function startApp() {
  const app = new App();
  await app.boot();
}
