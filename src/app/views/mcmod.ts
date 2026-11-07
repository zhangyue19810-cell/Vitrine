import { rpc } from "../api";
import { openLink } from "../actions";
import { $, debounce, html, onAll, safeUrl, setHtml } from "../dom";
import { formatCount } from "../format";
import { openSheet } from "../modal";
import type { ContentKind, McmodFilter, McmodItem, McmodSearchResult } from "../types";

const FILTERS: [McmodFilter, string][] = [
  ["mod", "模组"],
  ["modpack", "整合包"],
];

const FILTER_LABEL: Record<McmodFilter, string> = { all: "全部", mod: "模组", modpack: "整合包" };
const KIND_LABEL: Record<McmodItem["kind"], string> = { mod: "模组", modpack: "整合包", other: "资料" };
const FILTER_VALUE: Record<McmodFilter, string> = { all: "0", mod: "1", modpack: "2" };

/** A separate, read-only MC百科 browser. Installing still goes through Modrinth / CurseForge. */
export function openMcmodSearch(initialQuery = "", kind?: ContentKind) {
  const sheet = openSheet({ eyebrow: "MC百科 · 中文模组资料", title: "MC百科搜索" });
  const initialFilter: McmodFilter = kind === "modpack" ? "modpack" : "mod";
  let filter: McmodFilter = initialFilter;
  let page = 0;
  let total = 0;
  let pageSize = 30;
  let items: McmodItem[] = [];
  let loading = false;
  let error = "";
  let searched = false;
  let sequence = 0;

  sheet.body.innerHTML = `<div class="stack" style="gap:12px;height:100%;min-height:0">
    <div class="toolbar">
      <div class="search-input grow"><input class="input" data-mcmod-query maxlength="120" autocomplete="off" spellcheck="false" placeholder="输入模组中文名、英文名、作者或 ModID，回车搜索" /></div>
      <button class="btn accent" data-mcmod-go>搜索</button>
      <button class="btn sm soft" data-mcmod-site>在浏览器打开 ↗</button>
    </div>
    <div class="toolbar" style="justify-content:space-between;gap:12px">
      <div class="seg" data-mcmod-filters></div>
      <span class="muted" data-mcmod-info style="font-size:12px;text-align:right"></span>
    </div>
    <div class="br-grid" data-mcmod-results style="flex:1;min-height:0"></div>
    <div class="pager" data-mcmod-pager></div>
  </div>`;

  const f = <T extends HTMLElement = HTMLElement>(name: string) => $<T>(`[data-mcmod-${name}]`, sheet.body);
  const input = f<HTMLInputElement>("query");
  const info = f<HTMLElement>("info");
  const results = f<HTMLElement>("results");

  const setInfo = (text: string) => {
    info.textContent = text;
  };
  const renderFilters = () => {
    setHtml(f("filters"), html`${FILTERS.map(([value, label]) => html`<button data-mcmod-filter="${value}" aria-pressed="${value === filter}">${label}</button>`)}`);
  };
  const skeleton = () => html`${Array.from({ length: 6 }, () => html`<div class="proj"><div class="thumb lg skeleton"></div><div><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:11px;width:40%;margin-top:8px"></div></div><div class="skeleton" style="grid-column:1/-1;height:34px"></div></div>`)}`;
  const renderResults = () => {
    if (loading) return setHtml(results, skeleton());
    if (error) {
      return setHtml(results, html`<div class="empty" style="grid-column:1/-1"><b>MC百科搜索失败</b>${error}<br /><button class="btn sm soft" data-mcmod-retry>重试</button></div>`);
    }
    if (!searched) {
      return setHtml(results, html`<div class="empty" style="grid-column:1/-1"><b>搜索 MC百科</b>这里显示模组和整合包的中文资料页。下载安装仍然使用 Modrinth 或 CurseForge。</div>`);
    }
    if (!items.length) {
      return setHtml(results, html`<div class="empty" style="grid-column:1/-1"><b>没有找到相关条目</b>试试英文名、作者名或 ModID。MC百科的搜索索引是周期性更新的。</div>`);
    }
    setHtml(
      results,
      html`${items.map((item) => {
        const url = safeUrl(item.url);
        const english = item.titleEn && item.titleEn !== item.title ? item.titleEn : "";
        return html`<article class="proj">
          <div class="thumb lg">MC</div>
          <div style="min-width:0"><h4 title="${item.title}">${item.title}</h4><div class="by">MC百科 · ${KIND_LABEL[item.kind]}</div></div>
          <p title="${item.summary}">${item.summary}</p>
          <div class="foot"><div class="grow">${english ? html`<span class="chip" title="${english}">${english.slice(0, 38)}${english.length > 38 ? "…" : ""}</span>` : html`<span class="chip">中文资料</span>`}</div>
            ${url ? html`<button class="btn sm accent" data-mcmod-open="${url}">打开百科 ↗</button>` : ""}</div>
        </article>`;
      })}`,
    );
  };
  const renderPager = () => {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    setHtml(
      f("pager"),
      total
        ? html`<button class="btn sm soft" data-mcmod-page="-1" ${page === 0 ? "disabled" : ""}>上一页</button><span class="tnum">第 ${page + 1} / ${pages} 页 · 约 ${formatCount(total)} 条</span><button class="btn sm soft" data-mcmod-page="1" ${page + 1 >= pages ? "disabled" : ""}>下一页</button>`
        : html``,
    );
  };

  const search = async () => {
    const query = input.value.trim();
    if (!query) {
      items = [];
      total = 0;
      searched = false;
      error = "";
      loading = false;
      setInfo("输入关键词搜索 MC百科");
      renderResults();
      renderPager();
      input.focus({ preventScroll: true });
      return;
    }
    const mine = ++sequence;
    loading = true;
    error = "";
    searched = true;
    setInfo(`正在搜索 ${FILTER_LABEL[filter]}…`);
    renderResults();
    renderPager();
    try {
      const result = await rpc("mcmod.search", { query, filter, page });
      if (mine !== sequence || !sheet.body.isConnected) return;
      items = result.items;
      total = result.total;
      page = result.page;
      pageSize = result.pageSize;
    } catch (reason) {
      if (mine !== sequence || !sheet.body.isConnected) return;
      items = [];
      total = 0;
      error = (reason as Error).message;
    }
    loading = false;
    setInfo(total ? `找到约 ${formatCount(total)} 条${FILTER_LABEL[filter]}结果` : "没有找到结果");
    renderResults();
    renderPager();
    results.scrollTop = 0;
  };

  const debounced = debounce(() => {
    page = 0;
    void search();
  }, 650);

  renderFilters();
  setInfo("输入关键词搜索 MC百科");
  renderResults();
  renderPager();
  if (initialQuery.trim()) {
    input.value = initialQuery.trim();
    void search();
  } else input.focus({ preventScroll: true });

  onAll(sheet.body, "click", "[data-mcmod-go]", () => void search());
  onAll(sheet.body, "click", "[data-mcmod-retry]", () => void search());
  onAll(sheet.body, "click", "[data-mcmod-filter]", (element) => {
    const next = element.dataset.mcmodFilter as McmodFilter;
    if (next === filter) return;
    filter = next;
    page = 0;
    renderFilters();
    void search();
  });
  onAll(sheet.body, "click", "[data-mcmod-page]", (element) => {
    const next = Math.max(0, page + Number(element.dataset.mcmodPage));
    if (next === page) return;
    page = next;
    void search();
  });
  onAll(sheet.body, "click", "[data-mcmod-open]", (element) => void openLink(element.dataset.mcmodOpen!));
  onAll(sheet.body, "click", "[data-mcmod-site]", () => {
    const url = new URL("https://search.mcmod.cn/s");
    const query = input.value.trim();
    if (query) url.searchParams.set("key", query);
    url.searchParams.set("filter", FILTER_VALUE[filter]);
    void openLink(url.toString());
  });
  input.addEventListener("input", () => {
    // Invalidate an in-flight request immediately; the debounced search will get a newer sequence.
    sequence++;
    if (!input.value.trim()) {
      loading = false;
      error = "";
      searched = false;
      items = [];
      total = 0;
      setInfo("输入关键词搜索 MC百科");
      renderResults();
      renderPager();
      return;
    }
    debounced();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    page = 0;
    void search();
  });
}
