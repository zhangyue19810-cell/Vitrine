import { rpc, tryRpc } from "../api";
import { guard, openLink, withBusy } from "../actions";
import { $, debounce, html, Latest, onAll, safeUrl, setHtml } from "../dom";
import { formatCount, loaderLabel, relativeTime } from "../format";
import { openDialog, openSheet, promptDialog, toast, type ModalHandle } from "../modal";
import { displayName, primaryLoader } from "../records";
import { store } from "../store";
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
  const sheet = openSheet({ eyebrow: "BROWSE · MODRINTH / CURSEFORGE", title: "浏览内容", onClose: () => (open = undefined) });
  open = sheet;
  const state = {
    kind: options.kind ?? memory.kind,
    source: memory.source,
    sort: memory.sort,
    query: options.query ?? "",
    page: 0,
    total: 0,
    projects: [] as ContentProject[],
    instanceId: options.instanceId ?? undefined,
    anyVersion: false,
    curseforge: true,
    loading: false,
    error: "",
  };
  const token = new Latest();

  sheet.body.innerHTML = `
    <div class="br-bar">
      <div class="seg" data-f="kinds"></div>
      <div class="search-input"><input class="input" data-f="query" placeholder="搜索名称、作者或关键词" autocomplete="off" /></div>
      <div class="seg" data-f="sources"></div>
      <select class="select" data-f="sort" style="width:auto"></select>
    </div>
    <div class="br-bar" data-f="target-bar" style="padding-top:0"></div>
    <div data-f="notice"></div>
    <div class="br-grid" data-f="grid"></div>
    <div class="pager" data-f="pager"></div>`;
  const f = <T extends HTMLElement = HTMLElement>(name: string) => $<T>(`[data-f="${name}"]`, sheet.body);

  const instanceOf = (): InstanceSummary | undefined => store.instance(state.instanceId);

  const filters = () => {
    const instance = state.kind === "modpack" || state.anyVersion ? undefined : instanceOf();
    if (!instance) return {};
    return { gameVersion: instance.mcVersion, loader: state.kind === "mod" ? primaryLoader(instance)?.kind : undefined };
  };

  const renderChrome = () => {
    setHtml(f("kinds"), html`${KINDS.map((k) => html`<button data-kind="${k.id}" aria-pressed="${k.id === state.kind}">${k.label}</button>`)}`);
    setHtml(f("sources"), html`<button data-source="modrinth" aria-pressed="${state.source === "modrinth"}">Modrinth</button><button data-source="curseforge" aria-pressed="${state.source === "curseforge"}">CurseForge</button>`);
    const sort = f<HTMLSelectElement>("sort");
    sort.innerHTML = SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    sort.value = state.sort;
    const bar = f("target-bar");
    if (state.kind === "modpack") {
      setHtml(bar, html`<span class="muted" style="font-size:12.5px">整合包会安装成一个新的实例，文件通过多线程并行下载。</span>`);
    } else {
      const instances = store.instances.filter((entry) => entry.valid);
      if (!state.instanceId || !store.instance(state.instanceId)) state.instanceId = instances[0]?.id;
      const instance = instanceOf();
      setHtml(
        bar,
        instances.length
          ? html`<span class="micro">安装到</span>
              <select class="select" data-f="target" style="width:auto;min-width:240px">${instances.map((i) => html`<option value="${i.id}" ${i.id === state.instanceId ? "selected" : ""}>${displayName(i)} · ${i.mcVersion ?? "?"}${primaryLoader(i) ? ` · ${loaderLabel(primaryLoader(i)!.kind)}` : ""}</option>`)}</select>
              ${instance ? html`<label class="check" style="margin-left:10px"><input type="checkbox" data-f="any" ${state.anyVersion ? "checked" : ""} />不按这个实例的版本过滤</label>` : ""}
              ${instance && !state.anyVersion ? html`<span class="chip accent">${instance.mcVersion}${state.kind === "mod" && primaryLoader(instance) ? ` · ${loaderLabel(primaryLoader(instance)!.kind)}` : ""}</span>` : ""}`
          : html`<span class="chip warn">还没有实例，先去新建一个才能安装${KINDS.find((k) => k.id === state.kind)?.label}</span>`,
      );
    }
    f<HTMLInputElement>("query").value = state.query;
  };

  const renderNotice = () => {
    const host = f("notice");
    if (state.source === "curseforge" && !state.curseforge) {
      setHtml(host, html`<div class="notice warn" style="margin-bottom:12px"><div>CurseForge 需要 API 密钥才能搜索。请在 <a class="link" data-act="open-settings-accounts">设置 → 账号与密钥</a> 填写，或切换到 Modrinth。</div></div>`);
    } else setHtml(host, html``);
  };

  const renderGrid = () => {
    const grid = f("grid");
    if (state.loading) {
      setHtml(grid, html`${Array.from({ length: 6 }, () => html`<div class="proj"><div class="thumb lg skeleton"></div><div><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:11px;width:40%;margin-top:8px"></div></div><div class="skeleton" style="grid-column:1/-1;height:34px"></div></div>`)}`);
      return;
    }
    if (state.error) return setHtml(grid, html`<div class="empty" style="grid-column:1/-1"><b>搜索失败</b>${state.error}<br /><button class="btn sm soft" data-retry>重试</button></div>`);
    if (!state.projects.length) return setHtml(grid, html`<div class="empty" style="grid-column:1/-1"><b>没有找到结果</b>换个关键词，或者取消版本过滤试试。</div>`);
    setHtml(
      grid,
      html`${state.projects.map((p) => {
        const icon = safeUrl(p.iconUrl);
        return html`<article class="proj" data-project="${p.id}">
          <div class="thumb lg">${icon ? html`<img src="${icon}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : p.title.slice(0, 1).toUpperCase()}</div>
          <div style="min-width:0"><h4 title="${p.title}">${p.title}</h4><div class="by">${p.author ? `${p.author} · ` : ""}↓ ${formatCount(p.downloads)}${p.updatedAt ? ` · 更新 ${relativeTime(Date.parse(p.updatedAt))}` : ""}</div></div>
          <p>${p.summary}</p>
          <div class="foot"><div class="grow">${p.categories.slice(0, 3).map((c) => html`<span class="chip">${c}</span>`)}</div>
            <button class="btn sm ghost" data-page="${p.pageUrl}" title="在浏览器中打开">↗</button>
            <button class="btn sm soft" data-versions="${p.id}">版本…</button>
            <button class="btn sm accent" data-install="${p.id}">安装</button></div>
        </article>`;
      })}`,
    );
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
    try {
      const result = await rpc("content.search", { source: state.source, kind: state.kind, query: state.query || undefined, sort: state.sort as never, page: state.page, pageSize: PAGE_SIZE, ...filters() });
      if (!token.isCurrent(mine)) return;
      state.projects = result.projects;
      state.total = result.total;
    } catch (error) {
      if (!token.isCurrent(mine)) return;
      state.projects = [];
      state.total = 0;
      state.error = (error as Error).message;
    }
    state.loading = false;
    renderGrid();
    renderPager();
    f("grid").scrollTop = 0;
  };

  const debounced = debounce(() => {
    state.page = 0;
    void search();
  }, 350);

  onAll(sheet.body, "click", "[data-kind]", (element) => {
    state.kind = element.dataset.kind as ContentKind;
    state.page = 0;
    renderChrome();
    void search();
  });
  onAll(sheet.body, "click", "[data-source]", (element) => {
    state.source = element.dataset.source as ContentSource;
    state.page = 0;
    renderChrome();
    void search();
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
      debounced();
    }
  });
  sheet.body.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-f='sort']")) {
      state.sort = (target as HTMLSelectElement).value;
      state.page = 0;
      void search();
    } else if (target.matches("[data-f='target']")) {
      state.instanceId = (target as HTMLSelectElement).value;
      state.page = 0;
      renderChrome();
      void search();
    } else if (target.matches("[data-f='any']")) {
      state.anyVersion = (target as HTMLInputElement).checked;
      state.page = 0;
      renderChrome();
      void search();
    }
  });
  const find = (id: string) => state.projects.find((p) => p.id === id);
  onAll(sheet.body, "click", "[data-install]", async (element) => {
    const project = find(element.dataset.install!);
    if (project) await withBusy(element, () => install(project, undefined, state.instanceId, filters()));
  });
  onAll(sheet.body, "click", "[data-versions]", async (element) => {
    const project = find(element.dataset.versions!);
    if (project) await chooseVersion(project, state.instanceId, filters());
  });

  renderChrome();
  renderNotice();
  renderGrid();
  void (async () => {
    state.curseforge = (await tryRpc("content.status"))?.curseforge ?? false;
    await search();
  })();
}

// ---------------------------------------------------------------------------------------------- installing

async function chooseVersion(project: ContentProject, instanceId: string | undefined, filter: { gameVersion?: string; loader?: string }) {
  const body = document.createElement("div");
  body.innerHTML = `<div class="empty" style="min-height:120px"><span class="spinner"></span>正在获取版本列表…</div>`;
  const dialog = openDialog({ eyebrow: project.source.toUpperCase(), title: project.title, size: "wide", body, buttons: [{ id: "cancel", label: "关闭" }] });
  const versions = await guard(() => rpc("content.versions", { source: project.source, projectId: project.id, ...filter }));
  if (!versions) return dialog.close();
  if (!versions.length) {
    body.innerHTML = html`<div class="empty"><b>没有符合条件的版本</b>${filter.gameVersion ? html`这个项目没有适用于 ${filter.gameVersion}${filter.loader ? ` / ${loaderLabel(filter.loader)}` : ""} 的版本。` : ""}</div>`.value;
    return;
  }
  const shown = versions.slice(0, 60);
  body.innerHTML = html`<div class="list">${shown.map((v) => versionRow(v))}</div>${versions.length > shown.length ? html`<div class="muted" style="font-size:12px;padding:10px 4px">仅显示最新的 ${shown.length} 个版本</div>` : ""}`.value;
  onAll(body, "click", "[data-pick]", async (element) => {
    const picked = versions.find((v) => v.id === element.dataset.pick);
    if (!picked) return;
    const ok = await withBusy(element, () => install(project, picked, instanceId, filter));
    if (ok !== false) dialog.close();
  });
}

function versionRow(v: ContentVersion) {
  const channel = { release: "正式", beta: "测试", alpha: "早期" }[v.channel];
  return html`<div class="version-row"><div style="min-width:0"><div class="title" style="font-weight:600;font-size:13.5px">${v.name}</div><div class="sub" style="font-size:11.5px;color:var(--muted);margin-top:3px">${v.versionNumber} · ${v.gameVersions.slice(0, 4).join(", ")}${v.gameVersions.length > 4 ? "…" : ""} · ${v.loaders.map(loaderLabel).join(" / ")} · ${relativeTime(Date.parse(v.publishedAt))}</div></div><span class="chip ${v.channel === "release" ? "ok" : "warn"}">${channel}</span><button class="btn sm accent" data-pick="${v.id}">安装</button></div>`;
}

/** Install a project (the latest compatible version unless one is given). Resolves false when nothing was started. */
async function install(project: ContentProject, version: ContentVersion | undefined, instanceId: string | undefined, filter: { gameVersion?: string; loader?: string }): Promise<boolean> {
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
  const started = await guard(() => rpc("content.install", { instanceId, kind: project.kind as Exclude<ContentKind, "modpack">, source: project.source, projectId: project.id, versionId: version?.id, gameVersion: filter.gameVersion, loader: filter.loader, withDependencies: true, world, title: project.title }));
  if (!started) return false;
  toast(`正在安装 ${project.title}（含前置依赖）`, "ok");
  return true;
}

function pickWorld(worlds: { folder: string; name: string }[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dialog = openDialog({
      eyebrow: "DATA PACK",
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
