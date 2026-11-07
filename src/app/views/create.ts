import { rpc } from "../api";
import { guard, withBusy } from "../actions";
import { $, debounce, html, Latest, onAll, setHtml } from "../dom";
import { formatDate, LOADER_LABELS, VERSION_TYPE_LABELS } from "../format";
import { openSheet, toast, type ModalHandle } from "../modal";
import { store } from "../store";
import type { LoaderOverview, VersionList } from "../api";
import type { LoaderVersion } from "../types";

/** New instance: pick a Minecraft version on the left, a mod loader on the right, name it, install. */

type TypeFilter = "release" | "snapshot" | "old" | "all";

const LOADERS: { kind: string; blurb: string }[] = [
  { kind: "none", blurb: "纯净原版" },
  { kind: "fabric", blurb: "轻量，新版本模组多" },
  { kind: "quilt", blurb: "Fabric 的分支" },
  { kind: "forge", blurb: "经典模组加载器" },
  { kind: "neoforge", blurb: "1.20.2 起的 Forge 继任者" },
  { kind: "optifine", blurb: "高清修复 / 光影" },
];

let open: ModalHandle | undefined;

export function openCreate(initial?: { mcVersion?: string; loaderKind?: string }) {
  if (open) return;
  const sheet = openSheet({ eyebrow: "NEW INSTANCE", title: "新建实例", onClose: () => (open = undefined) });
  open = sheet;
  const state = {
    versions: undefined as VersionList | undefined,
    filter: "release" as TypeFilter,
    query: "",
    mc: initial?.mcVersion as string | undefined,
    overview: undefined as LoaderOverview | undefined,
    overviewError: "",
    loaderKind: "none",
    loaderVersions: [] as LoaderVersion[],
    loaderVersion: "",
    name: "",
    nameTouched: false,
  };
  const versionToken = new Latest();
  const loaderToken = new Latest();
  let pendingLoader = initial?.loaderKind;

  sheet.body.innerHTML = `<div class="wiz">
    <div class="wiz-col">
      <div class="micro">1 · Minecraft 版本</div>
      <div class="toolbar"><div class="search-input grow"><input class="input" data-f="search" placeholder="搜索版本号，如 1.21.1" autocomplete="off" /></div>
        <div class="seg" data-f="types"><button data-type="release" aria-pressed="true">正式版</button><button data-type="snapshot" aria-pressed="false">快照</button><button data-type="old" aria-pressed="false">远古</button><button data-type="all" aria-pressed="false">全部</button></div></div>
      <div class="pick-list" data-f="versions"><div class="empty"><span class="spinner"></span>正在获取版本列表…</div></div>
    </div>
    <div class="wiz-col" style="overflow:auto">
      <div class="micro">2 · 模组加载器（可选）</div>
      <div class="loader-grid" data-f="loaders"></div>
      <div class="field" data-f="loader-version-field" hidden><label>加载器版本</label><select class="select" data-f="loader-version"></select><div class="hint-text" data-f="loader-hint"></div></div>
      <div class="micro" style="margin-top:8px">3 · 名称与目录</div>
      <div class="field"><label>实例名称</label><input class="input" data-f="name" autocomplete="off" /><div class="hint-text" data-f="name-hint"></div></div>
    </div>
  </div>
  <div class="wiz-foot"><div class="wiz-summary" data-f="summary"></div><button class="btn accent lg" data-f="install" disabled>开始安装<span class="arrow">→</span></button></div>`;
  const root = sheet.body;
  const field = <T extends HTMLElement = HTMLElement>(name: string) => $<T>(`[data-f="${name}"]`, root);

  const defaultName = () => `${state.mc ?? ""}${state.loaderKind !== "none" ? `-${LOADER_LABELS[state.loaderKind] ?? state.loaderKind}` : ""}`;

  const validateName = (): string | undefined => {
    const name = state.name.trim();
    if (!name) return "请输入名称";
    if (/[\\/:*?"<>|]/.test(name)) return "名称不能包含 \\ / : * ? \" < > |";
    if (name.length > 64) return "名称太长";
    if (store.instances.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) return "已经有同名的实例";
    return undefined;
  };

  const renderVersions = () => {
    const list = state.versions;
    const host = field("versions");
    if (!list) return;
    const q = state.query.trim().toLowerCase();
    const filtered = list.versions.filter((v) => {
      if (q && !v.id.toLowerCase().includes(q)) return false;
      if (state.filter === "release") return v.type === "release";
      if (state.filter === "snapshot") return v.type === "snapshot";
      if (state.filter === "old") return v.type === "old_beta" || v.type === "old_alpha";
      return true;
    });
    if (!filtered.length) return setHtml(host, html`<div class="empty">没有匹配的版本</div>`);
    const shown = filtered.slice(0, 400);
    setHtml(
      host,
      html`${shown.map(
        (v) => html`<button class="pick" role="option" data-mc="${v.id}" aria-selected="${v.id === state.mc}"><span class="grow"><b>${v.id}</b></span>${v.id === list.latest.release ? html`<span class="chip accent">最新正式版</span>` : v.id === list.latest.snapshot && v.type === "snapshot" ? html`<span class="chip">最新快照</span>` : ""}<span class="muted" style="font-size:11.5px">${VERSION_TYPE_LABELS[v.type] ?? v.type} · ${formatDate(v.releaseTime)}</span></button>`,
      )}${filtered.length > shown.length ? html`<div class="empty" style="min-height:60px;font-size:12px">还有 ${filtered.length - shown.length} 个版本，请用搜索缩小范围</div>` : ""}`,
    );
    host.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  };

  const renderLoaders = () => {
    const host = field("loaders");
    setHtml(
      host,
      html`${LOADERS.map(({ kind, blurb }) => {
        const info = state.overview?.[kind];
        const unavailable = kind !== "none" && (!state.mc || (state.overview !== undefined && !info?.count));
        const detail = kind === "none" ? blurb : !state.mc ? blurb : !state.overview ? "查询中…" : info?.error ? "获取失败" : info?.count ? `${info.count} 个版本${info.recommended ? ` · 推荐 ${info.recommended}` : info.latest ? ` · 最新 ${info.latest}` : ""}` : "此版本暂无";
        return html`<button class="loader-card" data-loader="${kind}" aria-pressed="${kind === state.loaderKind}" ${unavailable ? "disabled" : ""}><b>${LOADER_LABELS[kind]}</b><span>${detail}</span></button>`;
      })}`,
    );
  };

  const renderLoaderVersions = () => {
    const wrap = field("loader-version-field");
    wrap.hidden = state.loaderKind === "none";
    if (state.loaderKind === "none") return;
    const select = field<HTMLSelectElement>("loader-version");
    select.innerHTML = state.loaderVersions
      .map((v) => `<option value="${v.version.replace(/"/g, "&quot;")}">${v.recommended ? "★ " : ""}${v.version.replace(/</g, "&lt;")}${v.recommended ? "（推荐）" : v.stable === false ? "（测试版）" : ""}</option>`)
      .join("");
    select.value = state.loaderVersion;
    field("loader-hint").textContent = state.loaderVersions.length ? "" : "正在获取加载器版本…";
  };

  const renderSummary = () => {
    const problem = validateName();
    const hint = field("name-hint");
    hint.textContent = state.nameTouched && problem ? problem : "";
    hint.style.color = state.nameTouched && problem ? "var(--danger)" : "";
    const loader = state.loaderKind === "none" ? "" : ` + ${LOADER_LABELS[state.loaderKind]} ${state.loaderVersion}`;
    setHtml(field("summary"), state.mc ? html`<b>Minecraft ${state.mc}</b>${loader}<br /><span class="muted">将作为“${state.name.trim() || "—"}”安装${store.settings.sources.policy.startsWith("mirror") ? "（镜像源优先）" : "（官方源优先，失败自动切换镜像）"}</span>` : html`<span class="muted">先在左侧选择一个 Minecraft 版本</span>`);
    field<HTMLButtonElement>("install").disabled = !state.mc || Boolean(problem) || (state.loaderKind !== "none" && !state.loaderVersion);
  };

  const pickMc = async (id: string) => {
    state.mc = id;
    state.overview = undefined;
    state.overviewError = "";
    state.loaderKind = "none";
    state.loaderVersions = [];
    state.loaderVersion = "";
    if (!state.nameTouched) {
      state.name = defaultName();
      field<HTMLInputElement>("name").value = state.name;
    }
    renderVersions();
    renderLoaders();
    renderLoaderVersions();
    renderSummary();
    const token = versionToken.next();
    try {
      const overview = await rpc("loaders.overview", { mcVersion: id });
      if (!versionToken.isCurrent(token)) return;
      state.overview = overview;
    } catch (error) {
      if (!versionToken.isCurrent(token)) return;
      state.overview = {};
      toast(`获取加载器列表失败：${(error as Error).message}`, "error");
    }
    renderLoaders();
    if (pendingLoader) {
      const kind = pendingLoader;
      pendingLoader = undefined;
      await pickLoader(kind);
    }
  };

  const pickLoader = async (kind: string) => {
    state.loaderKind = kind;
    state.loaderVersions = [];
    state.loaderVersion = "";
    if (!state.nameTouched) {
      state.name = defaultName();
      field<HTMLInputElement>("name").value = state.name;
    }
    renderLoaders();
    renderLoaderVersions();
    renderSummary();
    if (kind === "none" || !state.mc) return;
    const token = loaderToken.next();
    const versions = await guard(() => rpc("loaders.list", { kind, mcVersion: state.mc! }));
    if (!loaderToken.isCurrent(token) || !versions) return;
    state.loaderVersions = versions;
    state.loaderVersion = (versions.find((v) => v.recommended) ?? versions.find((v) => v.stable !== false) ?? versions[0])?.version ?? "";
    renderLoaderVersions();
    renderSummary();
  };

  onAll(root, "click", "[data-mc]", (element) => void pickMc(element.dataset.mc!));
  onAll(root, "click", "[data-loader]", (element) => void pickLoader(element.dataset.loader!));
  onAll(root, "click", "[data-type]", (element) => {
    state.filter = element.dataset.type as TypeFilter;
    root.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", String(b === element)));
    renderVersions();
  });
  field("search").addEventListener("input", debounce(() => {
    state.query = field<HTMLInputElement>("search").value;
    renderVersions();
  }, 120));
  field("name").addEventListener("input", () => {
    state.name = field<HTMLInputElement>("name").value;
    state.nameTouched = true;
    renderSummary();
  });
  field("loader-version").addEventListener("change", () => {
    state.loaderVersion = field<HTMLSelectElement>("loader-version").value;
    renderSummary();
  });
  field("install").addEventListener("click", async (event) => {
    if (!state.mc) return;
    state.nameTouched = true;
    const problem = validateName();
    if (problem) return renderSummary();
    const picked = state.loaderVersions.find((v) => v.version === state.loaderVersion);
    const loader = state.loaderKind === "none" || !picked ? undefined : { kind: picked.loader, version: picked.version, raw: picked.raw, meta: picked.meta };
    const started = await withBusy(event.currentTarget as HTMLElement, () => guard(() => rpc("instances.create", { name: state.name.trim(), mcVersion: state.mc!, loader })));
    if (!started) return;
    toast(`开始安装 ${state.name.trim()}`, "ok");
    sheet.close();
    (await import("./downloads")).openDownloads(started.taskId);
  });

  renderLoaders();
  renderSummary();
  void (async () => {
    const list = await guard(() => rpc("versions.list", {}), "获取版本列表失败：");
    if (!list) return setHtml(field("versions"), html`<div class="empty"><b>无法获取版本列表</b>请检查网络，或在设置里切换下载源。</div>`);
    state.versions = list;
    // The manifest's "latest" can be missing or point at something that is not listed; fall back to the newest release.
    const newest = list.versions.find((v) => v.id === list.latest.release && v.type === "release") ?? list.versions.find((v) => v.type === "release") ?? list.versions[0];
    const target = (state.mc && list.versions.find((v) => v.id === state.mc)) || (!state.mc ? newest : undefined);
    if (target) await pickMc(target.id);
    renderVersions();
  })();
}
