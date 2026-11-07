import { rpc, tryRpc } from "../api";
import { guard, openLink, withBusy } from "../actions";
import { $, debounce, html, Latest, onAll, safeUrl, setHtml } from "../dom";
import { formatCount, loaderLabel, relativeTime } from "../format";
import { openDialog, openSheet, promptDialog, toast, type ModalHandle } from "../modal";
import { displayName, primaryLoader } from "../records";
import { store } from "../store";
import { cachedTranslation, translateMany } from "../translate";
import { openMcmodSearch } from "./mcmod";
import type { ContentKind, ContentProject, ContentSource, ContentVersion, InstanceSummary } from "../types";

/** Browse Modrinth / CurseForge: modpacks (installed as a new instance) and mods, resource packs, shaders, data packs (installed into an instance). */

const KINDS: { id: ContentKind; label: string }[] = [
  { id: "modpack", label: "整合包" },
  { id: "mod", label: "模组" },
  { id: "resourcepack", label: "资源包" },
  { id: "shader", label: "光影" },
  { id: "datapack", label: "数据包" },
];

const SORTS: [string, string][] = [
  ["relevance", "相关度"],
  ["downloads", "下载量"],
  ["updated", "最近更新"],
  ["newest", "最新发布"],
];

const COMMON_VERSIONS = ["1.21.8", "1.21.7", "1.21.6", "1.21.5", "1.21.4", "1.21.1", "1.20.6", "1.20.4", "1.20.1", "1.19.4", "1.19.2", "1.18.2", "1.17.1", "1.16.5", "1.15.2", "1.12.2", "1.8.9", "1.7.10"];
const LOADERS: [string, string][] = [
  ["all", "全部加载器"],
  ["fabric", "Fabric"],
  ["forge", "Forge"],
  ["neoforge", "NeoForge"],
  ["quilt", "Quilt"],
];

/** Translate the category slugs returned by Modrinth / CurseForge. Proper names stay as-is. */
const CATEGORY_ZH: Record<string, string> = {
  adventure: "冒险",
  "adventure and rpg": "冒险与角色扮演",
  addons: "扩展",
  "api and library": "API 与前置库",
  "armor, tools, and weapons": "装备与武器",
  atmospheric: "氛围",
  audio: "声音",
  automation: "自动化",
  biomes: "生物群系",
  blocks: "方块",
  bloom: "泛光",
  cartoon: "卡通",
  combat: "战斗",
  cosmetic: "装饰",
  cursed: "整活",
  decoration: "装饰",
  dimensions: "维度",
  economy: "经济",
  energy: "能源",
  equipment: "装备",
  fantasy: "奇幻",
  farming: "农业",
  fluids: "流体",
  food: "食物",
  "game mechanics": "游戏机制",
  "game-mechanics": "游戏机制",
  genetics: "遗传",
  gui: "界面",
  library: "前置库",
  magic: "魔法",
  management: "管理",
  "map and information": "地图与信息",
  minigame: "小游戏",
  miscellaneous: "杂项",
  mobs: "生物",
  modpacks: "整合包",
  optimization: "优化",
  performance: "性能",
  "ores and resources": "矿物与资源",
  "player transport": "玩家交通",
  processing: "加工",
  realistic: "写实",
  redstone: "红石",
  resourcepack: "资源包",
  "resource packs": "资源包",
  shader: "光影",
  shaders: "光影",
  "semi-realistic": "半写实",
  "sci-fi": "科幻",
  "server utility": "服务器工具",
  social: "社交",
  storage: "存储",
  structures: "结构",
  technology: "科技",
  themed: "主题",
  tinkering: "工匠",
  transport: "交通",
  transportation: "交通",
  tweaks: "调整",
  utility: "实用工具",
  "vanilla-like": "原版风格",
  worldgen: "世界生成",
  "world gen": "世界生成",
};

const categoryLabel = (value: string) => CATEGORY_ZH[value.toLowerCase()] ?? value;
const sourceLabel = (value: ContentSource) => (value === "modrinth" ? "Modrinth" : "CurseForge");

interface VersionOption {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
}

const PAGE_SIZE = 20;

interface Memory {
  kind: ContentKind;
  source: ContentSource;
  sort: string;
}
const memory: Memory = { kind: "modpack", source: "modrinth", sort: "relevance" };

let open: ModalHandle | undefined;

export function openBrowse(options: { kind?: ContentKind; instanceId?: string; query?: string } = {}) {
  if (open) return;
  const sheet = openSheet({ eyebrow: "内容浏览 · 中文界面", title: "浏览内容", onClose: () => (open = undefined) });
  open = sheet;
  const state = {
    kind: options.kind ?? memory.kind,
    source: memory.source,
    sort: memory.sort,
    query: options.query ?? "",
    /** The query used for backend paging after a fuzzy/Chinese search was relaxed. */
    searchQuery: options.query ?? "",
    relaxedQuery: "",
    page: 0,
    total: 0,
    projects: [] as ContentProject[],
    instanceId: options.instanceId ?? undefined,
    gameVersion: "instance" as string,
    loader: "instance" as string,
    autoDependencies: true,
    curseforge: true,
    loading: false,
    error: "",
    versionOptions: COMMON_VERSIONS.map((id): VersionOption => ({ id, type: "release" })),
    versionsLoaded: false,
  };
  const token = new Latest();

  sheet.body.innerHTML = `
    <div class="br-bar">
      <div class="seg" data-f="kinds"></div>
      <div class="search-input"><input class="input" data-f="query" placeholder="搜索名称、作者或关键词（支持中文和模糊匹配）" autocomplete="off" /></div>
      <div class="seg" data-f="sources"></div>
      <button class="btn sm soft" data-mcmod-open title="在 MC百科搜索中文资料">MC百科</button>
      <select class="select" data-f="sort" style="width:auto"></select>
    </div>
    <div class="br-bar" data-f="target-bar" style="padding-top:0"></div>
    <div class="br-bar br-filters" data-f="filter-bar" style="padding-top:0"></div>
    <div data-f="notice"></div>
    <div class="br-grid" data-f="grid"></div>
    <div class="pager" data-f="pager"></div>`;
  const f = <T extends HTMLElement = HTMLElement>(name: string) => $<T>(`[data-f="${name}"]`, sheet.body);

  const instanceOf = (): InstanceSummary | undefined => store.instance(state.instanceId);

  const filters = () => {
    const instance = state.kind === "modpack" ? undefined : instanceOf();
    const gameVersion = state.gameVersion === "instance" ? instance?.mcVersion : state.gameVersion === "all" ? undefined : state.gameVersion;
    const loader =
      state.kind === "mod" || state.kind === "modpack"
        ? state.loader === "instance"
          ? state.kind === "mod"
            ? instance
              ? primaryLoader(instance)?.kind
              : undefined
            : undefined
          : state.loader === "all"
            ? undefined
            : state.loader
        : undefined;
    return gameVersion || loader ? { gameVersion, loader } : {};
  };

  const loadVersionOptions = async () => {
    const list = await tryRpc("versions.list", {});
    if (!list) return;
    const releases = list.versions.filter((version) => version.type === "release").slice(0, 80);
    const snapshots = list.versions.filter((version) => version.type === "snapshot").slice(0, 40);
    const versions = [...releases, ...snapshots];
    if (versions.length) state.versionOptions = versions;
    state.versionsLoaded = true;
    renderChrome();
  };

  const renderChrome = () => {
    setHtml(f("kinds"), html`${KINDS.map((k) => html`<button data-kind="${k.id}" aria-pressed="${k.id === state.kind}">${k.label}</button>`)}`);
    setHtml(
      f("sources"),
      html`<button data-source="modrinth" aria-pressed="${state.source === "modrinth"}">Modrinth 源</button><button data-source="curseforge" aria-pressed="${state.source === "curseforge"}">CurseForge 源</button>`,
    );
    const sort = f<HTMLSelectElement>("sort");
    sort.innerHTML = SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    sort.value = state.sort;

    const instance = instanceOf();
    const bar = f("target-bar");
    if (state.kind === "modpack") {
      setHtml(bar, html`<span class="muted" style="font-size:12.5px">整合包会安装成一个新的实例，文件通过多线程并行下载。</span>`);
    } else {
      const instances = store.instances.filter((entry) => entry.valid);
      if (!state.instanceId || !store.instance(state.instanceId)) state.instanceId = instances[0]?.id;
      setHtml(
        bar,
        instances.length
          ? html`<span class="micro">安装到</span>
              <select class="select" data-f="target" style="width:auto;min-width:240px">${instances.map((i) => html`<option value="${i.id}" ${i.id === state.instanceId ? "selected" : ""}>${displayName(i)} · ${i.mcVersion ?? "?"}${primaryLoader(i) ? ` · ${loaderLabel(primaryLoader(i)!.kind)}` : ""}</option>`)}</select>
              ${instance ? html`<span class="chip accent">${instance.mcVersion ?? "?"}${state.kind === "mod" && primaryLoader(instance) ? ` · ${loaderLabel(primaryLoader(instance)!.kind)}` : ""}</span>` : ""}`
          : html`<span class="chip warn">还没有实例，先去新建一个才能安装${KINDS.find((k) => k.id === state.kind)?.label}</span>`,
      );
    }

    const filterBar = f("filter-bar");
    const effectiveVersion = state.gameVersion === "instance" && !instance ? "all" : state.gameVersion;
    const versionIds = new Set(state.versionOptions.map((version) => version.id));
    const extraVersion = effectiveVersion !== "all" && effectiveVersion !== "instance" && !versionIds.has(effectiveVersion) ? effectiveVersion : "";
    const releases = state.versionOptions.filter((version) => version.type === "release");
    const snapshots = state.versionOptions.filter((version) => version.type === "snapshot");
    const loaderValue = state.loader === "instance" && !instance ? "all" : state.loader;
    setHtml(
      filterBar,
      html`<label class="br-filter"><span>游戏版本</span><select class="select" data-f="game-version">
          ${state.kind !== "modpack" && instance ? html`<option value="instance">跟随实例 · ${instance.mcVersion ?? "?"}</option>` : ""}
          <option value="all">全部版本</option>
          ${extraVersion ? html`<option value="${extraVersion}">${extraVersion}</option>` : ""}
          <optgroup label="正式版">${releases.map((version) => html`<option value="${version.id}">${version.id}</option>`)}</optgroup>
          ${snapshots.length ? html`<optgroup label="快照">${snapshots.map((version) => html`<option value="${version.id}">${version.id}</option>`)}</optgroup>` : ""}
        </select></label>
        ${state.kind === "mod" || state.kind === "modpack"
          ? html`<label class="br-filter"><span>加载器</span><select class="select" data-f="loader">
              ${state.kind === "mod" && instance ? html`<option value="instance">跟随实例</option>` : ""}
              ${LOADERS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}
            </select></label>`
          : ""}
        ${state.kind === "mod" ? html`<label class="check br-check"><input type="checkbox" data-f="deps" ${state.autoDependencies ? "checked" : ""} /> 智能安装前置</label>` : ""}
        <span class="chip accent" title="项目简介会尝试翻译成中文，服务不可用时显示原文">介绍自动汉化</span>
        ${state.versionsLoaded ? "" : html`<span class="micro muted">正在读取版本列表…</span>`}`,
    );
    f<HTMLSelectElement>("game-version").value = effectiveVersion;
    if (state.kind === "mod" || state.kind === "modpack") f<HTMLSelectElement>("loader").value = loaderValue;
    f<HTMLInputElement>("query").value = state.query;
  };

  const renderNotice = () => {
    const host = f("notice");
    const messages: ReturnType<typeof html>[] = [];
    if (state.source === "curseforge" && !state.curseforge) {
      messages.push(html`<div class="notice warn" style="margin-bottom:12px"><div>当前构建没有内置 CurseForge 搜索密钥，请切换到 Modrinth 源。</div></div>`);
    }
    if (state.relaxedQuery) {
      messages.push(html`<div class="notice" style="margin-bottom:12px"><div>没有找到足够精确的结果，已按相关关键词 <b>${state.relaxedQuery}</b> 搜索。</div></div>`);
    }
    setHtml(host, messages.length ? html`${messages}` : html``);
  };

  const renderGrid = () => {
    const grid = f("grid");
    if (state.loading) {
      setHtml(grid, html`${Array.from({ length: 6 }, () => html`<div class="proj"><div class="thumb lg skeleton"></div><div><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:11px;width:40%;margin-top:8px"></div></div><div class="skeleton" style="grid-column:1/-1;height:34px"></div></div>`)}`);
      return;
    }
    if (state.error) return setHtml(grid, html`<div class="empty" style="grid-column:1/-1"><b>搜索失败</b>${state.error}<br /><button class="btn sm soft" data-retry>重试</button></div>`);
    if (!state.projects.length) return setHtml(grid, html`<div class="empty" style="grid-column:1/-1"><b>没有找到结果</b>试试更短的关键词，或者取消版本和加载器过滤。搜索会自动尝试相关词。</div>`);
    setHtml(
      grid,
      html`${state.projects.map((p, index) => {
        const icon = safeUrl(p.iconUrl);
        const summary = cachedTranslation(p.summary) ?? p.summary;
        return html`<article class="proj" data-project="${p.id}">
          <div class="thumb lg">${icon ? html`<img src="${icon}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : p.title.slice(0, 1).toUpperCase()}</div>
          <div style="min-width:0"><h4 title="${p.title}">${p.title}</h4><div class="by">${p.author ? `${p.author} · ` : ""}↓ ${formatCount(p.downloads)}${p.updatedAt ? ` · 更新 ${relativeTime(Date.parse(p.updatedAt))}` : ""}</div></div>
          <p data-summary-index="${index}" title="${p.summary}" ${summary !== p.summary ? 'data-translated="true"' : ""}>${summary}</p>
          <div class="foot"><div class="grow">${p.categories.slice(0, 3).map((c) => html`<span class="chip" title="${c}">${categoryLabel(c)}</span>`)}</div>
            <button class="btn sm ghost" data-mcmod-project="${p.id}" title="在 MC百科搜索中文资料">百科</button>
            <button class="btn sm ghost" data-page="${p.pageUrl}" title="在浏览器中打开">↗</button>
            <button class="btn sm soft" data-versions="${p.id}">版本…</button>
            <button class="btn sm accent" data-install="${p.id}">安装</button></div>
        </article>`;
      })}`,
    );
  };

  const translateCards = async (mine: number) => {
    const snapshot = state.projects.slice();
    const translated = await translateMany(snapshot.map((project) => project.summary));
    if (!token.isCurrent(mine)) return;
    for (const node of sheet.body.querySelectorAll<HTMLElement>("[data-summary-index]")) {
      const project = snapshot[Number(node.dataset.summaryIndex)];
      if (!project) continue;
      const value = translated.get(project.summary) ?? cachedTranslation(project.summary);
      if (!value || value === project.summary) continue;
      node.textContent = value;
      node.title = `机器翻译。原文：${project.summary}`;
      node.dataset.translated = "true";
    }
  };

  const renderPager = () => {
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    setHtml(
      f("pager"),
      state.total
        ? html`<button class="btn sm soft" data-pg="-1" ${state.page === 0 ? "disabled" : ""}>上一页</button><span class="tnum">第 ${state.page + 1} / ${pages} 页 · 共 ${formatCount(state.total)} 个结果</span><button class="btn sm soft" data-pg="1" ${state.page + 1 >= pages ? "disabled" : ""}>下一页</button>`
        : html``,
    );
  };

  const search = async () => {
    memory.kind = state.kind;
    memory.source = state.source;
    memory.sort = state.sort;
    renderNotice();
    if (state.source === "curseforge" && !state.curseforge) {
      state.projects = [];
      state.total = 0;
      state.loading = false;
      renderGrid();
      renderPager();
      return;
    }
    const mine = token.next();
    state.loading = true;
    state.error = "";
    renderGrid();
    // Page 0 may let the backend choose a broader keyword. Later pages reuse that
    // effective keyword so the result set stays consistent from one page to the next.
    const requestedQuery = state.page === 0 ? state.query : state.searchQuery || state.query;
    try {
      const result = await rpc("content.search", { source: state.source, kind: state.kind, query: requestedQuery || undefined, sort: state.sort as never, page: state.page, pageSize: PAGE_SIZE, ...filters() });
      if (!token.isCurrent(mine)) return;
      state.projects = result.projects;
      state.total = result.total;
      if (state.page === 0) {
        state.searchQuery = result.effectiveQuery ?? state.query;
        state.relaxedQuery = result.relaxed ? state.searchQuery : "";
      }
    } catch (error) {
      if (!token.isCurrent(mine)) return;
      state.projects = [];
      state.total = 0;
      state.error = (error as Error).message;
    }
    state.loading = false;
    renderNotice();
    renderGrid();
    renderPager();
    f("grid").scrollTop = 0;
    void translateCards(mine);
  };

  const freshSearch = () => {
    state.page = 0;
    state.searchQuery = state.query;
    state.relaxedQuery = "";
    void search();
  };
  const debounced = debounce(freshSearch, 350);

  onAll(sheet.body, "click", "[data-kind]", (element) => {
    state.kind = element.dataset.kind as ContentKind;
    renderChrome();
    freshSearch();
  });
  onAll(sheet.body, "click", "[data-source]", (element) => {
    state.source = element.dataset.source as ContentSource;
    renderChrome();
    freshSearch();
  });
  onAll(sheet.body, "click", "[data-pg]", (element) => {
    state.page = Math.max(0, state.page + Number(element.dataset.pg));
    void search();
  });
  onAll(sheet.body, "click", "[data-retry]", () => void search());
  onAll(sheet.body, "click", "[data-page]", (element) => void openLink(element.dataset.page!));
  sheet.body.addEventListener("input", (event) => {
    if ((event.target as HTMLElement).matches("[data-f='query']")) {
      state.query = (event.target as HTMLInputElement).value;
      state.searchQuery = state.query;
      state.relaxedQuery = "";
      renderNotice();
      debounced();
    }
  });
  sheet.body.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-f='sort']")) {
      state.sort = (target as HTMLSelectElement).value;
      freshSearch();
    } else if (target.matches("[data-f='target']")) {
      state.instanceId = (target as HTMLSelectElement).value;
      renderChrome();
      freshSearch();
    } else if (target.matches("[data-f='game-version']")) {
      state.gameVersion = (target as HTMLSelectElement).value;
      renderChrome();
      freshSearch();
    } else if (target.matches("[data-f='loader']")) {
      state.loader = (target as HTMLSelectElement).value;
      renderChrome();
      freshSearch();
    } else if (target.matches("[data-f='deps']")) {
      state.autoDependencies = (target as HTMLInputElement).checked;
    }
  });
  const find = (id: string) => state.projects.find((p) => p.id === id);
  onAll(sheet.body, "click", "[data-mcmod-open]", () => openMcmodSearch(state.query, state.kind));
  onAll(sheet.body, "click", "[data-mcmod-project]", (element) => {
    const project = find(element.dataset.mcmodProject!);
    if (project) openMcmodSearch(project.title, project.kind);
  });
  onAll(sheet.body, "click", "[data-install]", async (element) => {
    const project = find(element.dataset.install!);
    if (project) await withBusy(element, () => install(project, undefined, state.instanceId, filters(), state.autoDependencies));
  });
  onAll(sheet.body, "click", "[data-versions]", async (element) => {
    const project = find(element.dataset.versions!);
    if (project) await chooseVersion(project, state.instanceId, filters(), state.autoDependencies);
  });

  renderChrome();
  renderNotice();
  renderGrid();
  void loadVersionOptions();
  void (async () => {
    state.curseforge = (await tryRpc("content.status"))?.curseforge ?? false;
    await search();
  })();
}

// ---------------------------------------------------------------------------------------------- installing

async function chooseVersion(project: ContentProject, instanceId: string | undefined, filter: { gameVersion?: string; loader?: string }, withDependencies = true) {
  const body = document.createElement("div");
  body.innerHTML = `<div class="empty" style="min-height:120px"><span class="spinner"></span>正在获取版本列表…</div>`;
  const dialog = openDialog({ eyebrow: `版本选择 · ${sourceLabel(project.source)}`, title: project.title, size: "wide", body, buttons: [{ id: "cancel", label: "关闭" }] });
  const versions = await guard(() => rpc("content.versions", { source: project.source, projectId: project.id, ...filter }));
  if (!versions) return dialog.close();
  if (!versions.length) {
    body.innerHTML = html`<div class="empty"><b>没有符合条件的版本</b>${filter.gameVersion ? html`这个项目没有适用于 ${filter.gameVersion}${filter.loader ? ` / ${loaderLabel(filter.loader)}` : ""} 的版本。` : ""}</div>`.value;
    return;
  }
  const shown = versions.slice(0, 60);
  body.innerHTML = html`${project.kind === "mod" && withDependencies ? html`<div class="notice" style="margin-bottom:10px">安装时会自动解析并安装必需的前置模组，已经装过的会跳过。</div>` : ""}<div class="list">${shown.map((v) => versionRow(v))}</div>${versions.length > shown.length ? html`<div class="muted" style="font-size:12px;padding:10px 4px">仅显示最新的 ${shown.length} 个版本</div>` : ""}`.value;
  onAll(body, "click", "[data-pick]", async (element) => {
    const picked = versions.find((v) => v.id === element.dataset.pick);
    if (!picked) return;
    const ok = await withBusy(element, () => install(project, picked, instanceId, filter, withDependencies));
    if (ok !== false) dialog.close();
  });
}

function versionRow(v: ContentVersion) {
  const channel = { release: "正式", beta: "测试", alpha: "早期" }[v.channel];
  const required = v.dependencies.filter((dependency) => dependency.kind === "required").length;
  return html`<div class="version-row"><div style="min-width:0"><div class="title" style="font-weight:600;font-size:13.5px">${v.name}</div><div class="sub" style="font-size:11.5px;color:var(--muted);margin-top:3px">${v.versionNumber} · ${v.gameVersions.slice(0, 4).join(", ")}${v.gameVersions.length > 4 ? "…" : ""} · ${v.loaders.map(loaderLabel).join(" / ")} · ${relativeTime(Date.parse(v.publishedAt))}${required ? ` · 需要 ${required} 个前置` : ""}</div></div><span class="chip ${v.channel === "release" ? "ok" : "warn"}">${channel}</span><button class="btn sm accent" data-pick="${v.id}">安装</button></div>`;
}

/** Install a project (the latest compatible version unless one is given). Resolves false when nothing was started. */
async function install(project: ContentProject, version: ContentVersion | undefined, instanceId: string | undefined, filter: { gameVersion?: string; loader?: string }, withDependencies = true): Promise<boolean> {
  if (project.kind === "modpack") {
    const name = await promptDialog({
      title: `安装整合包“${project.title}”`,
      label: "实例名称",
      value: project.title.replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 48),
      confirm: "开始安装",
      message: version ? `版本：${version.name}` : "将安装最新版本，也可以先点“版本…”选择指定版本。",
      validate: (value) => (!value ? "请输入名称" : store.instances.some((entry) => entry.name.toLowerCase() === value.toLowerCase()) ? "已经有同名的实例" : /[\\/:*?"<>|]/.test(value) ? "名称包含不能用于文件夹的字符" : undefined),
    });
    if (!name) return false;
    const started = await guard(() => rpc("packs.installOnline", { source: project.source, projectId: project.id, versionId: version?.id, name, title: project.title }));
    if (!started) return false;
    toast(`开始安装整合包 ${project.title}`, "ok");
    (await import("./downloads")).openDownloads(started.taskId);
    open?.close();
    return true;
  }
  if (!instanceId) {
    toast("请先选择要安装到的实例", "error");
    return false;
  }
  let world: string | undefined;
  if (project.kind === "datapack") {
    const worlds = await guard(() => rpc("worlds.list", { instanceId }));
    if (!worlds) return false;
    if (!worlds.length) {
      toast("这个实例还没有存档，进游戏创建一个世界后才能安装数据包", "error");
      return false;
    }
    world = await pickWorld(worlds.map((w) => ({ folder: w.folder, name: w.name })));
    if (!world) return false;
  }
  const started = await guard(() => rpc("content.install", { instanceId, kind: project.kind as Exclude<ContentKind, "modpack">, source: project.source, projectId: project.id, versionId: version?.id, gameVersion: filter.gameVersion, loader: filter.loader, withDependencies, world, title: project.title }));
  if (!started) return false;
  toast(`正在安装 ${project.title}（含前置依赖）`, "ok");
  return true;
}

function pickWorld(worlds: { folder: string; name: string }[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = openDialog({
      eyebrow: "数据包安装",
      title: "安装到哪个世界？",
      size: "narrow",
      body: html`<div class="list">${worlds.map((w) => html`<button class="pick" data-world="${w.folder}"><span class="grow">${w.name}</span><span class="muted mono" style="font-size:11px">${w.folder}</span></button>`)}</div>`,
      buttons: [{ id: "cancel", label: "取消" }],
    });
    dialog.root.addEventListener("click", (event) => {
      const pick = (event.target as HTMLElement).closest<HTMLElement>("[data-world]");
      if (!pick) return;
      resolve(pick.dataset.world);
      dialog.finishWith("picked");
    });
    void dialog.result.then(() => resolve(undefined));
  });
}
