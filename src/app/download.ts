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
import { cachedTranslation, translateMany } from "./translate";
import type { ContentKind, ContentProject, ContentSource, InstanceSummary } from "./types";
import { chooseVersion, install, SORTS } from "./views/browse";
import { openMcmodSearch } from "./views/mcmod";

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
const COMMON_VERSIONS = ["1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.21.1", "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.19.2", "1.18.2", "1.17.1", "1.16.5", "1.15.2", "1.12.2", "1.8.9", "1.7.10"];
const LOADERS: [string, string][] = [
  ["all", "全部加载器"],
  ["fabric", "Fabric"],
  ["forge", "Forge"],
  ["neoforge", "NeoForge"],
  ["quilt", "Quilt"],
];

interface VersionOption {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
}

/** Remembered between visits, like the old browse sheet did. */
const memory: { source: ContentSource; sort: string } = { source: "modrinth", sort: "relevance" };

export class DownloadView {
  private active = false;
  private kind: ContentKind = "mod";
  private query = "";
  private source: ContentSource = memory.source;
  private sort = memory.sort;
  private instanceId: string | undefined;
  /** "instance": follow the selected instance, "all": no filter, otherwise an explicit version / loader. */
  private gameVersion = "instance";
  private loader = "instance";
  private autoDependencies = true;
  private searchQuery = "";
  private relaxedQuery = "";
  private versionOptions: VersionOption[] = COMMON_VERSIONS.map((id): VersionOption => ({ id, type: "release" }));
  private versionsLoaded = false;
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
          <label class="dl-search"><span class="glyph" aria-hidden="true">⌕</span><input class="input" data-f="query" placeholder="搜索名称、作者或关键词（支持中文和模糊匹配）" autocomplete="off" spellcheck="false" /></label>
          <div class="seg" data-f="sources"></div>
          <select class="select dl-sort" data-f="sort" aria-label="排序"></select>
          <button class="btn sm soft" data-mcmod-open title="在 MC百科搜索中文资料">MC百科</button>
        </div>
        <div class="dl-filters" data-f="filter-bar"></div>
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
    this.gameVersion = "instance";
    this.loader = "instance";
    this.searchQuery = "";
    this.relaxedQuery = "";
    this.resetResults();
    this.pickInstance();
    this.renderChrome();
    this.renderState();
    this.host.showRow(placeholderItems(kind), 0);
    void this.loadVersionOptions();
    await this.checkStatus();
    await this.reload("replace");
  }

  /** Another category while the row is up: the archives are pulled apart, then new ones gather. */
  async switchKind(kind: ContentKind) {
    if (!this.active) return void (await this.enter(kind));
    if (kind === this.kind) return;
    this.kind = kind;
    this.query = "";
    this.gameVersion = "instance";
    this.loader = "instance";
    this.searchQuery = "";
    this.relaxedQuery = "";
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
    const previous = this.instanceId;
    this.pickInstance();
    this.renderChrome();
    if (previous !== this.instanceId && (this.gameVersion === "instance" || this.loader === "instance")) void this.reload("swap");
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
    const instance = this.kind === "modpack" ? undefined : this.instanceOf();
    const gameVersion = this.gameVersion === "instance" ? instance?.mcVersion : this.gameVersion === "all" ? undefined : this.gameVersion;
    const loader =
      this.kind === "mod" || this.kind === "modpack"
        ? this.loader === "instance"
          ? this.kind === "mod" && instance
            ? primaryLoader(instance)?.kind
            : undefined
          : this.loader === "all"
            ? undefined
            : this.loader
        : undefined;
    return gameVersion || loader ? { gameVersion, loader } : {};
  }

  private async loadVersionOptions() {
    if (this.versionsLoaded) return;
    this.versionsLoaded = true;
    const list = await tryRpc("versions.list", {});
    if (!list) {
      this.versionsLoaded = false;
      return;
    }
    const releases = list.versions.filter((version) => version.type === "release").slice(0, 80);
    const snapshots = list.versions.filter((version) => version.type === "snapshot").slice(0, 40);
    const versions = [...releases, ...snapshots];
    if (versions.length) this.versionOptions = versions;
    this.renderChrome();
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
      this.finish(mine, result.projects, result.total, "", mode, result.effectiveQuery, Boolean(result.relaxed));
    } catch (error) {
      this.finish(mine, [], 0, (error as Error).message, mode);
    }
  }

  private finish(
    mine: number,
    projects: ContentProject[],
    total: number,
    error: string,
    mode: "replace" | "swap",
    effectiveQuery?: string,
    relaxed = false,
  ) {
    if (!this.token.isCurrent(mine) || !this.active) return;
    this.loading = false;
    this.projects = projects;
    this.total = total;
    this.error = error;
    this.searchQuery = effectiveQuery ?? this.query;
    this.relaxedQuery = relaxed && effectiveQuery ? effectiveQuery : "";
    this.exhausted = projects.length === 0 || projects.length >= total;
    const items = projects.map((project) => projectItem(project, this.cachedIcon(project), this.summaryOf(project)));
    if (mode === "replace") this.host.replaceRow(items);
    else this.host.swapRow(items);
    this.renderChrome();
    this.renderState();
    void this.host.preloadFonts(fontSample(items.map((item) => item.payload as FacePayload)));
    this.queueIcons(0, projects.length);
    this.translateSummaries(projects, 0);
  }

  /** Chinese summaries for the archive faces; the raw English text stays visible until a translation arrives. */
  private summaryOf(project: ContentProject): string {
    return cachedTranslation(project.summary) ?? project.summary;
  }

  private translateSummaries(projects: ContentProject[], offset: number) {
    if (!projects.length) return;
    const generation = this.generation;
    const snapshot = projects.slice();
    void translateMany(snapshot.map((project) => project.summary)).then(() => {
      if (!this.active || generation !== this.generation) return;
      snapshot.forEach((project, index) => {
        const summary = cachedTranslation(project.summary);
        if (!summary || summary === project.summary) return;
        const row = offset + index;
        const current = this.projects[row];
        if (!current || current.source !== project.source || current.id !== project.id) return;
        this.host.updateRow(row, projectItem(project, this.cachedIcon(project), summary));
      });
    });
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
        query: this.searchQuery || this.query || undefined,
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
      const items = fresh.map((project) => projectItem(project, this.cachedIcon(project), this.summaryOf(project)));
      if (items.length) this.host.appendRow(items);
      void this.host.preloadFonts(fontSample(items.map((item) => item.payload as FacePayload)));
      this.queueIcons(start, this.projects.length);
      this.translateSummaries(fresh, start);
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
        this.host.updateRow(job.index, projectItem(project, this.icons.get(url), this.summaryOf(project)));
        continue;
      }
      this.iconBusy++;
      void this.fetchIcon(project.iconUrl!).then((image) => {
        this.iconBusy--;
        this.icons.set(url, image);
        if (this.icons.size > ICON_CACHE) this.icons.delete(this.icons.keys().next().value as string);
        if (job.generation === this.generation && this.active) this.host.updateRow(job.index, projectItem(project, image, this.summaryOf(project)));
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
    if (id === "mcmod") return openMcmodSearch(project.title, project.kind);
    if (id === "versions") return void chooseVersion(project, this.instanceId, this.filters(), this.autoDependencies);
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
    await guard(() => install(project, undefined, this.instanceId, this.filters(), this.autoDependencies));
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
        this.searchQuery = this.query;
        this.relaxedQuery = "";
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
      } else if (target.matches("[data-f='game-version']")) {
        this.gameVersion = (target as HTMLSelectElement).value;
        this.renderChrome();
        void this.reload("swap");
      } else if (target.matches("[data-f='loader']")) {
        this.loader = (target as HTMLSelectElement).value;
        this.renderChrome();
        void this.reload("swap");
      } else if (target.matches("[data-f='deps']")) {
        this.autoDependencies = (target as HTMLInputElement).checked;
      }
    });
    root.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-source], [data-retry], [data-mcmod-open]");
      if (!target) return;
      if (target.dataset.mcmodOpen !== undefined) {
        openMcmodSearch(this.query, this.kind);
      } else if (target.dataset.source) {
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

    const bar = this.f("filter-bar");
    const instances = store.instances.filter((entry) => entry.valid);
    const instance = this.instanceOf();
    const target =
      this.kind === "modpack"
        ? html`<span class="dl-note">整合包会安装成一个新的实例，文件多线程并行下载</span>`
        : instances.length
          ? html`<span class="micro">安装到</span>
              <select class="select" data-f="target" aria-label="安装到哪个实例">${instances.map((entry) => html`<option value="${entry.id}" ${entry.id === this.instanceId ? "selected" : ""}>${displayName(entry)} · ${entry.mcVersion ?? "?"}${primaryLoader(entry) ? ` · ${loaderLabel(primaryLoader(entry)!.kind)}` : ""}</option>`)}</select>`
          : html`<span class="chip warn">还没有实例，先回首页新建一个才能安装${KIND_LABEL[this.kind]}</span>`;

    const effectiveVersion = this.gameVersion === "instance" && !instance ? "all" : this.gameVersion;
    const versionIds = new Set(this.versionOptions.map((version) => version.id));
    const extraVersion = effectiveVersion !== "all" && effectiveVersion !== "instance" && !versionIds.has(effectiveVersion) ? effectiveVersion : "";
    const releases = this.versionOptions.filter((version) => version.type === "release");
    const snapshots = this.versionOptions.filter((version) => version.type === "snapshot");
    const loaderValue = this.loader === "instance" && !instance ? "all" : this.loader;
    const loaderFilter =
      this.kind === "mod" || this.kind === "modpack"
        ? html`<label class="dl-filter"><span>加载器</span><select class="select" data-f="loader" aria-label="加载器">
            ${this.kind === "mod" && instance ? html`<option value="instance">跟随实例</option>` : ""}
            ${LOADERS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}
          </select></label>`
        : html``;
    setHtml(
      bar,
      html`${target}
        <label class="dl-filter"><span>游戏版本</span><select class="select" data-f="game-version" aria-label="游戏版本">
          ${this.kind !== "modpack" && instance ? html`<option value="instance">跟随实例 · ${instance.mcVersion ?? "?"}</option>` : ""}
          <option value="all">全部版本</option>
          ${extraVersion ? html`<option value="${extraVersion}">${extraVersion}</option>` : ""}
          <optgroup label="正式版">${releases.map((version) => html`<option value="${version.id}">${version.id}</option>`)}</optgroup>
          ${snapshots.length ? html`<optgroup label="快照">${snapshots.map((version) => html`<option value="${version.id}">${version.id}</option>`)}</optgroup>` : ""}
        </select></label>
        ${loaderFilter}
        ${this.kind === "mod" ? html`<label class="check dl-check"><input type="checkbox" data-f="deps" ${this.autoDependencies ? "checked" : ""} /> 智能安装前置</label>` : ""}
        <span class="chip accent" title="项目简介会尝试翻译成中文，服务不可用时显示原文">介绍自动汉化</span>
        ${this.versionsLoaded ? "" : html`<span class="micro muted">正在读取版本列表…</span>`}`,
    );
    const versionSelect = bar.querySelector<HTMLSelectElement>("[data-f='game-version']");
    if (versionSelect) versionSelect.value = effectiveVersion;
    const loaderSelect = bar.querySelector<HTMLSelectElement>("[data-f='loader']");
    if (loaderSelect) loaderSelect.value = loaderValue;
    this.renderCount();
  }

  private renderCount() {
    const label = KIND_LABEL[this.kind];
    const count = this.f("count");
    if (this.loading) return setHtml(count, html`<b>正在搜索${label}…</b>`);
    if (this.error) return setHtml(count, html`<b>搜索失败</b>`);
    if (!this.projects.length) return setHtml(count, html`<b>共 0 个${label}</b>`);
    const detail = this.relaxedQuery
      ? html`<span title="没有找到足够精确的结果，已按相关关键词搜索">已按相关词「${this.relaxedQuery}」搜索</span>`
      : html`<span>第 ${Math.min(this.projects.length, this.selected + 1)} 个${this.loadingMore ? " · 加载更多…" : ""}</span>`;
    setHtml(count, html`<b>共 ${formatCount(this.total)} 个${label}</b>${detail}`);
  }

  /** Words in the middle of the picture for the cases where there are no archives to look at. */
  private renderState() {
    const state = this.f("state");
    if (this.error) {
      return setHtml(state, html`<div class="dl-message"><b>搜索失败</b>${this.error}<br /><button class="btn sm soft" data-retry>重试</button></div>`);
    }
    if (this.source === "curseforge" && !this.curseforge && !this.loading) {
      return setHtml(state, html`<div class="dl-message"><b>当前构建没有内置 CurseForge 搜索密钥</b>请切换到 Modrinth 源，内置密钥只会在正式安装包里生效。</div>`);
    }
    if (!this.loading && !this.projects.length) {
      return setHtml(state, html`<div class="dl-message"><b>没有找到结果</b>试试更短的关键词，或者放宽版本和加载器过滤。搜索会自动尝试相关词。</div>`);
    }
    setHtml(state, html``);
  }
}
