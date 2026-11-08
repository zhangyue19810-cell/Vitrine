import { guard, openLink } from "./actions";
import { rpc, tryRpc } from "./api";
import { $, debounce, html, Latest, safeUrl, setHtml } from "./dom";
import { fontSample, type FacePayload } from "./faces";
import { formatCount, loaderLabel } from "./format";
import { toast } from "./modal";
import { displayName, primaryLoader } from "./records";
import type { SceneHost } from "./scene-host";
import { KIND_LABEL, placeholderItems, projectItem } from "./stage-items";
import { store } from "./store";
import type { ContentKind, ContentProject, ContentSource, InstanceSummary } from "./types";
import { chooseVersion, install, SORTS } from "./views/browse";

/**
 * The download view: ONE row of archives on the glass track. The search results are the archives; the one under selection is
 * pulled out to the left and printed with its details and buttons. This class owns everything that is not 3D: the search
 * state, the controls under the picture, the icons that arrive late, paging when the row runs out, and the install buttons.
 *
 *   home ring ──(a tab is clicked)──▶ the ring's archives regroup into the row (faces turn over to the first results)
 *   row, kind A ──(another tab / new search)──▶ archives pull apart to both sides, new ones fly in from all around
 *   row ──(首页)──▶ the row's archives regroup back into the ring
 */

const PAGE_SIZE = 20;
const ICON_CONCURRENCY = 4;
const ICON_CACHE = 320;

/** Remembered between visits, like the old browse sheet did. */
const memory: { source: ContentSource; sort: string } = { source: "modrinth", sort: "relevance" };

export class DownloadView {
  private active = false;
  private kind: ContentKind = "mod";
  private query = "";
  private source: ContentSource = memory.source;
  private sort = memory.sort;
  private instanceId: string | undefined;
  private anyVersion = false;
  private curseforge = true;
  private statusKnown = false;
  private projects: ContentProject[] = [];
  private total = 0;
  private page = 0;
  private loading = false;
  private loadingMore = false;
  private exhausted = false;
  private error = "";
  private selected = 0;
  private readonly token = new Latest();
  /** Bumps whenever the result set is replaced, so that icons of an old set are not printed on the new one. */
  private generation = 0;
  private readonly icons = new Map<string, HTMLImageElement | null>();
  private iconBusy = 0;
  private iconQueue: { generation: number; index: number }[] = [];
  private readonly searchLater = debounce(() => void this.reload("swap"), 380);

  constructor(
    private readonly host: SceneHost,
    private readonly root: HTMLElement,
    /** The instance that the home ring has selected: the first choice for "install into". */
    private readonly currentInstance: () => string | undefined,
  ) {
    root.innerHTML = `
      <div class="dl-bar">
        <div class="dl-count" data-f="count" aria-live="polite"></div>
        <div class="dl-controls">
          <label class="dl-search"><span class="glyph" aria-hidden="true">⌕</span><input class="input" data-f="query" placeholder="搜索名称、作者或关键词" autocomplete="off" spellcheck="false" /></label>
          <div class="seg" data-f="sources"></div>
          <select class="select dl-sort" data-f="sort" aria-label="排序"></select>
          <div class="dl-target" data-f="target-bar"></div>
        </div>
      </div>
      <div class="dl-state" data-f="state" role="status"></div>
      <div class="dl-hint"><kbd>滚轮</kbd><kbd>←</kbd><kbd>→</kbd>切换 · 点击档案抽出 · <kbd>Enter</kbd>安装 · <kbd>/</kbd>搜索 · <kbd>Esc</kbd>回到首页</div>`;
    this.bind();
  }

  private f<T extends HTMLElement = HTMLElement>(name: string) {
    return $<T>(`[data-f="${name}"]`, this.root);
  }

  get isActive() {
    return this.active;
  }

  get kindLabel() {
    return KIND_LABEL[this.kind];
  }

  // ───────────────────────────────────────────── entering, leaving, switching ─────────────────────────────────────────────

  /** Come from the home ring: the archives regroup into the row while the first results are being fetched. */
  async enter(kind: ContentKind) {
    this.active = true;
    this.kind = kind;
    this.query = "";
    this.resetResults();
    this.pickInstance();
    this.renderChrome();
    this.renderState();
    this.host.showRow(placeholderItems(kind), 0);
    await this.checkStatus();
    await this.reload("replace");
  }

  /** Another category while the row is up: the archives are pulled apart, then new ones gather. */
  async switchKind(kind: ContentKind) {
    if (!this.active) return void (await this.enter(kind));
    if (kind === this.kind) return;
    this.kind = kind;
    this.query = "";
    this.pickInstance();
    this.renderChrome();
    await this.reload("swap");
  }

  leave() {
    this.active = false;
    this.token.next();
    this.generation++;
    this.iconQueue = [];
    this.loading = false;
    this.loadingMore = false;
    this.searchLater.cancel?.();
  }

  /** The list of instances changed (one was created, one was deleted): keep the "install into" choice valid. */
  refreshTargets() {
    if (!this.active) return;
    this.pickInstance();
    this.renderChrome();
  }

  // ───────────────────────────────────────────── searching ─────────────────────────────────────────────

  private resetResults() {
    this.projects = [];
    this.total = 0;
    this.page = 0;
    this.exhausted = false;
    this.error = "";
    this.selected = 0;
    this.loading = false;
    this.loadingMore = false;
  }

  private async checkStatus() {
    if (this.statusKnown) return;
    this.curseforge = (await tryRpc("content.status"))?.curseforge ?? false;
    this.statusKnown = true;
  }

  private instanceOf(): InstanceSummary | undefined {
    return store.instance(this.instanceId);
  }

  private filters() {
    const instance = this.kind === "modpack" || this.anyVersion ? undefined : this.instanceOf();
    if (!instance) return {};
    return { gameVersion: instance.mcVersion, loader: this.kind === "mod" ? primaryLoader(instance)?.kind : undefined };
  }

  private pickInstance() {
    const instances = store.instances.filter((entry) => entry.valid);
    const wanted = this.currentInstance();
    if (wanted && instances.some((entry) => entry.id === wanted) && !this.instanceId) this.instanceId = wanted;
    if (!this.instanceId || !instances.some((entry) => entry.id === this.instanceId)) this.instanceId = wanted && instances.some((entry) => entry.id === wanted) ? wanted : instances[0]?.id;
  }

  /** A new result set: "replace" fills the blanks the row was entered with, "swap" pulls the old archives apart first. */
  private async reload(mode: "replace" | "swap") {
    if (!this.active) return;
    memory.source = this.source;
    memory.sort = this.sort;
    const mine = this.token.next();
    this.generation++;
    this.iconQueue = [];
    this.resetResults();
    this.loading = true;
    this.renderChrome();
    this.renderState();
    if (mode === "swap") this.host.swapRow(null);
    if (this.source === "curseforge" && !this.curseforge) return this.finish(mine, [], 0, "", mode);
    try {
      const result = await rpc("content.search", {
        source: this.source,
        kind: this.kind,
        query: this.query || undefined,
        sort: this.sort as never,
        page: 0,
        pageSize: PAGE_SIZE,
        ...this.filters(),
      });
      this.finish(mine, result.projects, result.total, "", mode);
    } catch (error) {
      this.finish(mine, [], 0, (error as Error).message, mode);
    }
  }

  private finish(mine: number, projects: ContentProject[], total: number, error: string, mode: "replace" | "swap") {
    if (!this.token.isCurrent(mine) || !this.active) return;
    this.loading = false;
    this.projects = projects;
    this.total = total;
    this.error = error;
    this.exhausted = projects.length === 0 || projects.length >= total;
    const items = projects.map((project) => projectItem(project, this.cachedIcon(project)));
    if (mode === "replace") this.host.replaceRow(items);
    else this.host.swapRow(items);
    this.renderChrome();
    this.renderState();
    void this.host.preloadFonts(fontSample(items.map((item) => item.payload as FacePayload)));
    this.queueIcons(0, projects.length);
  }

  /** The row is nearly at its end (the stage says so): fetch the next page and add its archives behind the others. */
  loadMore() {
    if (!this.active || this.loading || this.loadingMore || this.exhausted || this.error) return;
    void this.fetchPage();
  }

  private async fetchPage() {
    this.loadingMore = true;
    this.renderChrome();
    const mine = this.token.next();
    const generation = this.generation;
    const nextPage = this.page + 1;
    try {
      const result = await rpc("content.search", {
        source: this.source,
        kind: this.kind,
        query: this.query || undefined,
        sort: this.sort as never,
        page: nextPage,
        pageSize: PAGE_SIZE,
        ...this.filters(),
      });
      if (!this.token.isCurrent(mine) || generation !== this.generation) return;
      const known = new Set(this.projects.map((project) => `${project.source}:${project.id}`));
      const fresh = result.projects.filter((project) => !known.has(`${project.source}:${project.id}`));
      const start = this.projects.length;
      this.page = nextPage;
      this.total = Math.max(result.total, this.projects.length + fresh.length);
      this.projects = this.projects.concat(fresh);
      this.exhausted = result.projects.length === 0 || this.projects.length >= this.total;
      const items = fresh.map((project) => projectItem(project, this.cachedIcon(project)));
      if (items.length) this.host.appendRow(items);
      void this.host.preloadFonts(fontSample(items.map((item) => item.payload as FacePayload)));
      this.queueIcons(start, this.projects.length);
    } catch {
      // The row simply stays as long as it is; scrolling to the end again tries once more.
    } finally {
      if (this.token.isCurrent(mine)) {
        this.loadingMore = false;
        this.renderChrome();
      }
    }
  }

  // ───────────────────────────────────────────── icons ─────────────────────────────────────────────

  /** undefined: not fetched yet; null: none available; otherwise the decoded image. */
  private cachedIcon(project: ContentProject): HTMLImageElement | null | undefined {
    const url = safeUrl(project.iconUrl);
    if (!url) return null;
    return this.icons.has(url) ? this.icons.get(url) : undefined;
  }

  private queueIcons(from: number, to: number) {
    for (let index = from; index < to; index++) {
      const project = this.projects[index];
      const url = project && safeUrl(project.iconUrl);
      if (url && !this.icons.has(url)) this.iconQueue.push({ generation: this.generation, index });
    }
    this.pumpIcons();
  }

  private pumpIcons() {
    while (this.iconBusy < ICON_CONCURRENCY && this.iconQueue.length) {
      const job = this.iconQueue.shift()!;
      if (job.generation !== this.generation) continue;
      const project = this.projects[job.index];
      const url = project && safeUrl(project.iconUrl);
      if (!url) continue;
      if (this.icons.has(url)) {
        this.host.updateRow(job.index, projectItem(project, this.icons.get(url)));
        continue;
      }
      this.iconBusy++;
      void this.fetchIcon(project.iconUrl!).then((image) => {
        this.iconBusy--;
        this.icons.set(url, image);
        if (this.icons.size > ICON_CACHE) this.icons.delete(this.icons.keys().next().value as string);
        if (job.generation === this.generation && this.active) this.host.updateRow(job.index, projectItem(project, image));
        this.pumpIcons();
      });
    }
  }

  /** Remote icons cannot be read into a texture (no CORS), so the core fetches them and hands back a data URL. */
  private async fetchIcon(url: string): Promise<HTMLImageElement | null> {
    try {
      const data = await tryRpc("content.icon", { url });
      if (!data) return null;
      const image = new Image();
      image.src = data;
      await image.decode();
      return image;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────── what the stage reports ─────────────────────────────────────────────

  onSelect(index: number) {
    this.selected = index;
    this.renderCount();
  }

  /** A button on the pulled-out archive was clicked. */
  handleAction(id: string, index: number) {
    const project = this.projects[index];
    if (!project) return;
    if (id === "page") return void openLink(project.pageUrl);
    if (id === "versions") return void chooseVersion(project, this.instanceId, this.filters());
    if (id === "install") void this.installProject(project);
  }

  installSelected() {
    const index = this.host.stage?.selectedItem ?? this.selected;
    this.handleAction("install", index);
  }

  private async installProject(project: ContentProject) {
    if (project.kind !== "modpack" && !this.instanceId) {
      toast(store.instances.length ? "请先在下方选择要安装到的实例" : "还没有实例，先回首页新建一个才能安装", "error");
      return;
    }
    await guard(() => install(project, undefined, this.instanceId, this.filters()));
  }

  step(direction: number) {
    this.host.stage?.step(direction);
  }

  focusSearch() {
    const input = this.f<HTMLInputElement>("query");
    input.focus();
    input.select();
  }

  // ───────────────────────────────────────────── controls ─────────────────────────────────────────────

  private bind() {
    const root = this.root;
    root.addEventListener("input", (event) => {
      const target = event.target as HTMLElement;
      if (target.matches("[data-f='query']")) {
        this.query = (target as HTMLInputElement).value;
        this.searchLater();
      }
    });
    root.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (event.key === "Escape" && target.matches("input, select")) {
        (target as HTMLInputElement).blur();
        event.stopPropagation();
      } else if (event.key === "Enter" && target.matches("[data-f='query']")) {
        event.preventDefault();
        this.searchLater.cancel?.();
        void this.reload("swap");
        (target as HTMLInputElement).blur();
      }
    });
    root.addEventListener("change", (event) => {
      const target = event.target as HTMLElement;
      if (target.matches("[data-f='sort']")) {
        this.sort = (target as HTMLSelectElement).value;
        void this.reload("swap");
      } else if (target.matches("[data-f='target']")) {
        this.instanceId = (target as HTMLSelectElement).value;
        this.renderChrome();
        void this.reload("swap");
      } else if (target.matches("[data-f='any']")) {
        this.anyVersion = (target as HTMLInputElement).checked;
        this.renderChrome();
        void this.reload("swap");
      }
    });
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-source], [data-retry]");
      if (!target) return;
      if (target.dataset.source) {
        this.source = target.dataset.source as ContentSource;
        this.renderChrome();
        void this.reload("swap");
      } else void this.reload(this.projects.length ? "swap" : "replace");
    });
  }

  private renderChrome() {
    setHtml(
      this.f("sources"),
      html`<button data-source="modrinth" aria-pressed="${this.source === "modrinth"}">Modrinth</button><button data-source="curseforge" aria-pressed="${this.source === "curseforge"}">CurseForge</button>`,
    );
    const sort = this.f<HTMLSelectElement>("sort");
    if (!sort.options.length) sort.innerHTML = SORTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    sort.value = this.sort;
    const query = this.f<HTMLInputElement>("query");
    if (document.activeElement !== query) query.value = this.query;

    const bar = this.f("target-bar");
    if (this.kind === "modpack") {
      setHtml(bar, html`<span class="dl-note">整合包会安装成一个新的实例，文件多线程并行下载</span>`);
    } else {
      const instances = store.instances.filter((entry) => entry.valid);
      const instance = this.instanceOf();
      setHtml(
        bar,
        instances.length
          ? html`<span class="micro">安装到</span>
              <select class="select" data-f="target" aria-label="安装到哪个实例">${instances.map((entry) => html`<option value="${entry.id}" ${entry.id === this.instanceId ? "selected" : ""}>${displayName(entry)} · ${entry.mcVersion ?? "?"}${primaryLoader(entry) ? ` · ${loaderLabel(primaryLoader(entry)!.kind)}` : ""}</option>`)}</select>
              ${instance ? html`<label class="check"><input type="checkbox" data-f="any" ${this.anyVersion ? "checked" : ""} />不按版本过滤</label>` : ""}`
          : html`<span class="chip warn">还没有实例，先回首页新建一个才能安装${KIND_LABEL[this.kind]}</span>`,
      );
    }
    this.renderCount();
  }

  private renderCount() {
    const label = KIND_LABEL[this.kind];
    const count = this.f("count");
    if (this.loading) return setHtml(count, html`<b>正在搜索${label}…</b>`);
    if (this.error) return setHtml(count, html`<b>搜索失败</b>`);
    if (!this.projects.length) return setHtml(count, html`<b>共 0 个${label}</b>`);
    setHtml(count, html`<b>共 ${formatCount(this.total)} 个${label}</b><span>第 ${Math.min(this.projects.length, this.selected + 1)} 个${this.loadingMore ? " · 加载更多…" : ""}</span>`);
  }

  /** Words in the middle of the picture for the cases where there are no archives to look at. */
  private renderState() {
    const state = this.f("state");
    if (this.error) {
      return setHtml(state, html`<div class="dl-message"><b>搜索失败</b>${this.error}<br /><button class="btn sm soft" data-retry>重试</button></div>`);
    }
    if (this.source === "curseforge" && !this.curseforge && !this.loading) {
      return setHtml(state, html`<div class="dl-message"><b>CurseForge 需要 API 密钥</b>请在 <a class="link" data-act="open-settings-accounts">设置 → 账号与密钥</a> 填写，或切换到 Modrinth。</div>`);
    }
    if (!this.loading && !this.projects.length) {
      return setHtml(state, html`<div class="dl-message"><b>没有找到结果</b>换个关键词，或者取消版本过滤试试。</div>`);
    }
    setHtml(state, html``);
  }
}
