import { rpc } from "../api";
import { awaitTask, guard, openFolder, openLink, withBusy } from "../actions";
import { $, $$, Latest, html, onAll, setHtml } from "../dom";
import { formatBytes } from "../format";
import { openMenu } from "../menu";
import { confirmDialog, openDialog, toast } from "../modal";
import type { LocalMod, ModProblem, ModUpdate } from "../types";
import { loaderLabel } from "../format";
import type { TabContext, TabHandle } from "./detail-types";
import { openDownloads } from "./downloads";
import { currentSpringForce, springElement, springReveal } from "../spring-ui";

type Filter = "all" | "enabled" | "disabled" | "problem";

const KIND_LABEL: Record<ModProblem["kind"], string> = { duplicate: "重复", "missing-dependency": "缺少前置", "disabled-dependency": "前置被禁用", incompatible: "不兼容", "wrong-loader": "加载器不对", unreadable: "无法读取" };

/** A compact Chinese → English aid for the installed-mod filter. */
const MOD_SEARCH_ALIASES: Record<string, string[]> = {
  "优化": ["optimization", "performance"],
  "性能": ["performance", "optimization"],
  "光影": ["shader", "shaders"],
  "资源包": ["resourcepack", "resource pack"],
  "数据包": ["datapack", "data pack"],
  "科技": ["technology", "tech"],
  "工业": ["industrial", "technology"],
  "机械": ["machinery", "technology"],
  "魔法": ["magic"],
  "冒险": ["adventure"],
  "农业": ["farming"],
  "存储": ["storage"],
  "背包": ["backpack", "inventory"],
  "装饰": ["decoration"],
  "建筑": ["building"],
  "家具": ["furniture"],
  "照明": ["lighting"],
  "红石": ["redstone"],
  "能源": ["energy"],
  "地图": ["map"],
  "小地图": ["minimap"],
  "传送": ["teleport"],
  "结构": ["structures"],
  "生物": ["mobs"],
  "怪物": ["mobs"],
  "战斗": ["combat"],
  "武器": ["weapons"],
  "装备": ["equipment"],
  "工具": ["tools"],
  "任务": ["quests"],
  "经济": ["economy"],
  "服务器": ["server"],
  "界面": ["gui", "interface"],
  "字体": ["font"],
  "汉化": ["translation", "chinese"],
  "中文": ["chinese"],
  "音乐": ["music"],
  "声音": ["sound", "audio"],
  "天气": ["weather"],
  "季节": ["seasons"],
  "渲染": ["rendering"],
  "启动": ["startup"],
  "内存": ["memory"],
  "实用": ["utility"],
  "辅助": ["utility"],
  "前置": ["library", "api"],
};

const MOD_SEARCH_STOPWORDS = new Set(["a", "an", "the", "and", "or", "for", "of", "to", "in", "with", "on", "mod", "mods", "minecraft", "mc", "我的世界", "模组"]);

const normalizeSearch = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}._+-]+/gu, " ").trim();
const isCjk = (value: string) => /[\u3400-\u9fff]/.test(value);

function editDistanceAtMost(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const next = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      current.push(next);
      rowMin = Math.min(rowMin, next);
    }
    if (rowMin > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

function expandModSearchTerms(query: string): string[] {
  let text = normalizeSearch(query);
  const aliases: string[] = [];
  for (const [term, words] of Object.entries(MOD_SEARCH_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    if (!text.includes(term)) continue;
    aliases.push(...words);
    text = text.split(term).join(" ");
  }
  const tokens = normalizeSearch(text).split(/\s+/).filter((token) => token.length > 1 || isCjk(token));
  return [...new Set([...tokens, ...aliases])].filter((token) => !MOD_SEARCH_STOPWORDS.has(token));
}

function fuzzyFieldScore(text: string, words: string[], term: string): number {
  if (text.includes(term)) return 10;
  const compact = term.replace(/\s+/g, "");
  if (compact.length >= 3 && text.replace(/\s+/g, "").includes(compact)) return 8;
  if (term.length < 4 || isCjk(term)) return 0;
  const limit = term.length >= 8 ? 2 : 1;
  for (const word of words) {
    if (word.length >= 3 && word.startsWith(term)) return 6;
    if (editDistanceAtMost(term, word, limit)) return 4;
  }
  return 0;
}

export function mount(ctx: TabContext): TabHandle {
  const { body, signal } = ctx;
  body.innerHTML = `<div class="stack" style="gap:14px">
    <div class="toolbar">
      <div class="search-input grow"><input class="input" data-q placeholder="搜索模组名称、ID、作者…（支持模糊和中文关键词）" autocomplete="off" /></div>
      <div class="seg" data-filter><button data-v="all" aria-pressed="true">全部</button><button data-v="enabled" aria-pressed="false">已启用</button><button data-v="disabled" aria-pressed="false">已禁用</button><button data-v="problem" aria-pressed="false">有问题</button></div>
    </div>
    <div class="toolbar"><button class="btn sm accent" data-act="mods-install">＋ 安装模组</button><button class="btn sm" data-act="mods-check" data-updates="0">检查更新</button><button class="btn sm soft" data-act="mods-folder">打开 mods 文件夹</button><button class="btn sm mod-problem-trigger" data-act="mods-problems" data-problems="0" aria-haspopup="dialog" aria-expanded="false" title="悬停或点击查看注意事项" hidden>注意 <b data-f="problem-count">0</b></button><span class="muted grow" data-f="summary" style="font-size:12px;text-align:right"></span></div>
    <div data-f="list"><div class="skeleton" style="height:58px;margin-bottom:6px"></div><div class="skeleton" style="height:58px;margin-bottom:6px"></div><div class="skeleton" style="height:58px"></div></div>
  </div>`;
  const f = (name: string) => $(`[data-f="${name}"]`, body);
  const problemTrigger = body.querySelector<HTMLButtonElement>('[data-act="mods-problems"]')!;
  const latest = new Latest();
  let mods: LocalMod[] = [];
  let problems: ModProblem[] = [];
  let updates: ModUpdate[] = [];
  let query = "";
  let filter: Filter = "all";
  let loadedCount = -1;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;
  const icons = new Map<string, string | null>();
  const queue: HTMLElement[] = [];
  let inflight = 0;
  let problemPopover: HTMLElement | undefined;
  let problemCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let problemPinned = false;
  let problemFocusGuard = false;
  let problemOutsideListener: ((event: PointerEvent) => void) | undefined;
  let problemKeyListener: ((event: KeyboardEvent) => void) | undefined;

  const problemFiles = () => new Set(problems.flatMap((problem) => problem.files));

  // ------------------------------------------------------------------------------------------ list
  async function load(keepScroll = false) {
    const token = latest.next();
    const scroll = body.scrollTop;
    try {
      const result = await rpc("mods.list", { instanceId: ctx.instance().id }, signal);
      if (!latest.isCurrent(token) || signal.aborted) return;
      mods = result.mods;
      problems = result.problems;
      loadedCount = ctx.instance().modCount;
      ctx.setCount(mods.length);
      paintProblems();
      paintList();
      if (keepScroll) body.scrollTop = scroll;
    } catch (error) {
      if (signal.aborted || !latest.isCurrent(token)) return;
      setHtml(f("list"), html`<div class="empty"><b>读取模组失败</b><div>${(error as Error).message}</div><div><button class="btn soft" data-act="mods-reload">重试</button></div></div>`);
    }
  }

  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(true), 250);
  };

  function matchScore(mod: LocalMod, bad: Set<string>): { visible: boolean; score: number } {
    if (filter === "enabled" && mod.disabled) return { visible: false, score: 0 };
    if (filter === "disabled" && !mod.disabled) return { visible: false, score: 0 };
    if (filter === "problem" && !(bad.has(mod.file) || bad.has(mod.path))) return { visible: false, score: 0 };
    if (!query) return { visible: true, score: 0 };

    const meta = mod.meta;
    const terms = expandModSearchTerms(query);
    if (!terms.length) return { visible: false, score: 0 };
    const strong = normalizeSearch(`${meta?.name ?? ""} ${meta?.id ?? ""} ${mod.file}`);
    const weak = normalizeSearch(
      `${meta?.description ?? ""} ${(meta?.authors ?? []).join(" ")} ${meta?.version ?? ""} ${(meta?.provides ?? []).join(" ")} ${(meta?.extra ?? []).flatMap((entry) => [entry.id, entry.name ?? ""]).join(" ")}`,
    );
    const strongWords = strong.split(/\s+/).filter(Boolean);
    const weakWords = weak.split(/\s+/).filter(Boolean);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const hit = Math.max(fuzzyFieldScore(strong, strongWords, term), fuzzyFieldScore(weak, weakWords, term) * 0.6);
      if (!hit) continue;
      matched++;
      score += hit;
    }
    if (`${strong} ${weak}`.includes(normalizeSearch(query))) score += 12;
    // A phrase with two or more words is a hint, not a requirement: show anything that strongly
    // matches at least one part and rank the closest matches first.
    const visible = matched === terms.length || (terms.length > 1 && matched > 0);
    return { visible, score };
  }

  function row(mod: LocalMod, index: number, bad: Set<string>) {
    const meta = mod.meta;
    const name = meta?.name ?? meta?.id ?? mod.file.replace(/\.jar(\.disabled)?$/i, "");
    const loaders = (meta?.loaders ?? []).map((kind) => loaderLabel(kind === "legacy-forge" ? "forge" : kind));
    const sub = [meta?.version, loaders[0], meta?.authors?.[0], formatBytes(mod.size)].filter(Boolean).join(" · ");
    const flagged = bad.has(mod.file) || bad.has(mod.path);
    return html`<div class="mod-row" data-i="${index}" data-disabled="${mod.disabled}" ${matchScore(mod, bad).visible ? "" : "hidden"}>
      <button class="toggle" role="switch" aria-checked="${!mod.disabled}" data-toggle title="${mod.disabled ? "启用" : "禁用"}"></button>
      <span class="thumb" data-icon="${mod.path}">${name.slice(0, 1).toUpperCase()}</span>
      <div class="info" style="min-width:0"><div class="name" title="${mod.file}">${name}</div><div class="sub" title="${mod.error ?? mod.file}">${mod.error ? `无法读取信息：${mod.error}` : sub}</div></div>
      <div class="row-flex">${flagged ? html`<span class="chip warn">有问题</span>` : ""}${meta?.environment === "client" ? html`<span class="chip">仅客户端</span>` : ""}<button class="btn icon sm ghost" data-more aria-haspopup="menu" title="更多">⋯</button></div>
    </div>`;
  }

  function paintList() {
    const bad = problemFiles();
    const list = f("list");
    if (!mods.length) {
      setHtml(list, html`<div class="empty"><b>这个实例还没有安装模组</b><div>${ctx.instance().loaders.some((loader) => loader.kind !== "none" && loader.kind !== "optifine") ? "点“安装模组”从 Modrinth 或 CurseForge 添加，也可以把 .jar 文件放进 mods 文件夹。" : "这是原版实例。要使用模组，请新建带有 Fabric / Forge / NeoForge 的实例。"}</div></div>`);
      updateSummary();
      return;
    }
    observer?.disconnect();
    queue.length = 0;
    setHtml(list, html`${mods.map((mod, index) => row(mod, index, bad))}<div class="empty" data-none hidden><b>没有找到相近的模组</b><div>少输几个字，或者只搜索模组名称里的一个关键词。</div></div>`);
    applyFilter();
    observeIcons();
  }

  function applyFilter() {
    const bad = problemFiles();
    const list = f("list");
    const ranked: { element: HTMLElement; index: number; score: number }[] = [];
    for (const element of $$(".mod-row", list)) {
      const mod = mods[Number(element.dataset.i)];
      const result = mod ? matchScore(mod, bad) : { visible: false, score: 0 };
      if (element.hidden === result.visible) element.hidden = !result.visible;
      if (result.visible) ranked.push({ element, index: Number(element.dataset.i), score: result.score });
    }
    ranked.sort((a, b) => (query ? b.score - a.score || a.index - b.index : a.index - b.index));
    for (const entry of ranked) list.append(entry.element);
    const none = list.querySelector<HTMLElement>("[data-none]");
    if (none) {
      none.hidden = ranked.length > 0 || !mods.length;
      list.append(none);
    }
    updateSummary(ranked.length);
  }

  function updateSummary(shown = mods.length) {
    const disabled = mods.filter((mod) => mod.disabled).length;
    const suffix = shown !== mods.length ? ` · 显示 ${shown}` : "";
    f("summary").textContent = mods.length ? `共 ${mods.length} 个${disabled ? `（${disabled} 个已禁用）` : ""}${suffix}${query && shown ? " · 按相关度排序" : ""}` : "";
  }

  // ------------------------------------------------------------------------------------------ icons (only for rows that scroll into view)
  function observeIcons() {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const thumb = entry.target.querySelector<HTMLElement>("[data-icon]");
          if (!thumb || thumb.dataset.state) continue;
          thumb.dataset.state = "queued";
          queue.push(thumb);
          observer?.unobserve(entry.target);
        }
        pump();
      },
      { root: body, rootMargin: "120px" },
    );
    for (const element of $$(".mod-row", f("list"))) observer.observe(element);
  }

  function pump() {
    while (inflight < 4 && queue.length) {
      const thumb = queue.shift()!;
      if (!thumb.isConnected) continue;
      const path = thumb.dataset.icon!;
      inflight++;
      void (async () => {
        try {
          let icon = icons.get(path);
          if (icon === undefined) {
            icon = (await rpc("mods.icon", { instanceId: ctx.instance().id, path }, signal)) ?? null;
            icons.set(path, icon);
          }
          if (icon && thumb.isConnected && /^data:image\/(png|jpeg|gif|webp);base64,/.test(icon)) {
            thumb.classList.add("pixel");
            thumb.textContent = "";
            const image = document.createElement("img");
            image.alt = "";
            image.decoding = "async";
            image.src = icon;
            thumb.append(image);
          }
        } catch {
          /* no icon: the initial stays */
        } finally {
          inflight--;
          pump();
        }
      })();
    }
  }

  // ------------------------------------------------------------------------------------------ problems
  function problemAction(problem: ModProblem) {
    if (problem.kind === "duplicate") return { how: "dedupe", label: "只留最新的" };
    if (problem.fix?.kind === "install-dependency") return { how: "dependency", label: "一键补齐" };
    if (problem.fix?.kind === "enable-mod") return { how: "enable", label: "启用前置" };
    if (problem.fix?.kind === "switch-loader") return { how: "loader", label: "更换加载器" };
    return undefined;
  }

  function problemRow(problem: ModProblem, index: number) {
    const action = problemAction(problem);
    return html`<div class="problem"><span class="chip warn" style="flex:none">${KIND_LABEL[problem.kind]}</span><div style="flex:1;min-width:0"><div>${problem.message}</div><div class="muted" style="font-size:11.5px;margin-top:3px;overflow-wrap:anywhere">${problem.files.join("、")}</div></div>${action ? html`<button class="btn sm" data-problem="${index}" data-fix="${action.how}">${action.label}</button>` : ""}</div>`;
  }

  function problemPopoverMarkup() {
    return html`<header class="mod-problem-head"><div><div class="micro">MOD CHECKS</div><b>需要注意 ${problems.length} 项</b></div><button class="btn icon ghost sm" data-problem-close aria-label="关闭" title="关闭">✕</button></header><div class="mod-problem-list">${problems.map((problem, index) => problemRow(problem, index))}</div><div class="mod-problem-note">这些是结构检查，不会自动修改文件。缺少的前置可以点右侧按钮处理。</div>`;
  }

  function paintProblems() {
    problemTrigger.hidden = problems.length === 0;
    problemTrigger.dataset.problems = String(problems.length);
    if (!problems.length) closeProblemPopover(true);
    problemTrigger.setAttribute("aria-expanded", String(Boolean(problemPopover)));
    const count = problemTrigger.querySelector<HTMLElement>("[data-f='problem-count']");
    if (count) count.textContent = String(problems.length);
    if (problemPopover?.isConnected) {
      const title = problemPopover.querySelector<HTMLElement>(".mod-problem-head b");
      const list = problemPopover.querySelector<HTMLElement>(".mod-problem-list");
      const note = problemPopover.querySelector<HTMLElement>(".mod-problem-note");
      if (title) title.textContent = `需要注意 ${problems.length} 项`;
      if (list) list.innerHTML = problems.map((problem, index) => problemRow(problem, index).value).join("");
      if (note) note.textContent = `这些是结构检查，不会自动修改文件。${problems.length ? "缺少的前置可以点右侧按钮处理。" : ""}`;
    }
  }

  function closeProblemPopover(immediate = false) {
    clearTimeout(problemCloseTimer);
    problemPinned = false;
    problemTrigger.setAttribute("aria-expanded", "false");
    if (!problemPopover) return;
    const panel = problemPopover;
    problemPopover = undefined;
    if (problemOutsideListener) document.removeEventListener("pointerdown", problemOutsideListener, true);
    if (problemKeyListener) document.removeEventListener("keydown", problemKeyListener, true);
    problemOutsideListener = undefined;
    problemKeyListener = undefined;
    if (immediate) {
      panel.remove();
      return;
    }
    panel.classList.add("leaving");
    void springElement(panel, {
      toY: 6,
      toScale: 0.97,
      toOpacity: 0,
      response: 0.26,
      dampingRatio: 0.94,
      retainFinal: true,
    }).then(() => panel.remove());
  }

  function showProblemPopover(pin = false) {
    if (!problems.length) return;
    clearTimeout(problemCloseTimer);
    if (pin) problemPinned = true;
    if (problemPopover) {
      problemTrigger.setAttribute("aria-expanded", "true");
      return;
    }
    const stage = document.querySelector<HTMLElement>("#stage");
    if (!stage) return;
    const panel = document.createElement("section");
    panel.className = "mod-problem-popover";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "模组注意事项");
    panel.innerHTML = problemPopoverMarkup().value;
    stage.append(panel);
    problemPopover = panel;
    problemTrigger.setAttribute("aria-expanded", "true");
    const stageRect = stage.getBoundingClientRect();
    const scale = stageRect.width / stage.offsetWidth || 1;
    const triggerRect = problemTrigger.getBoundingClientRect();
    panel.style.width = `${Math.min(560, Math.max(360, stage.offsetWidth - 32))}px`;
    panel.style.left = "0px";
    panel.style.top = "0px";
    panel.style.visibility = "hidden";
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const triggerRight = (triggerRect.right - stageRect.left) / scale;
    const triggerTop = (triggerRect.top - stageRect.top) / scale;
    const triggerBottom = (triggerRect.bottom - stageRect.top) / scale;
    const left = Math.max(8, Math.min(stage.offsetWidth - panelWidth - 8, triggerRight - panelWidth));
    let top = triggerBottom + 8;
    if (top + panelHeight > stage.offsetHeight - 8) top = Math.max(8, triggerTop - panelHeight - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    void springElement(panel, {
      fromY: 10,
      toY: 0,
      fromScale: 0.94,
      toScale: 1,
      fromOpacity: 0,
      toOpacity: 1,
      fromClip: 0,
      toClip: 160,
      clipOrigin: "100% 0%",
      transformOrigin: "100% 0%",
      response: 0.36,
      dampingRatio: 0.78,
      force: currentSpringForce(),
    }).then(() => panel.style.removeProperty("clip-path"));
    panel.style.visibility = "visible";

    const keepOpen = () => clearTimeout(problemCloseTimer);
    const closeSoon = () => {
      clearTimeout(problemCloseTimer);
      problemCloseTimer = setTimeout(() => {
        if (problemPinned || panel.matches(":hover") || panel.contains(document.activeElement) || problemTrigger.contains(document.activeElement)) return;
        closeProblemPopover();
      }, 120);
    };
    panel.addEventListener("pointerenter", keepOpen);
    panel.addEventListener("pointerleave", closeSoon);
    panel.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-problem-close]")) return closeProblemPopover();
      const button = target.closest<HTMLElement>("[data-problem]");
      if (!button) return;
      const problem = problems[Number(button.dataset.problem)];
      if (!problem) return;
      void fixProblem(problem, button.dataset.fix ?? "", button);
      closeProblemPopover();
    });
    problemOutsideListener = (event) => {
      if (!problemPopover || problemPopover.contains(event.target as Node) || problemTrigger.contains(event.target as Node)) return;
      closeProblemPopover(true);
    };
    problemKeyListener = (event) => {
      if (event.key !== "Escape" || !problemPopover) return;
      event.preventDefault();
      problemFocusGuard = true;
      closeProblemPopover(true);
      problemTrigger.focus({ preventScroll: true });
      setTimeout(() => { problemFocusGuard = false; }, 0);
    };
    document.addEventListener("pointerdown", problemOutsideListener, true);
    document.addEventListener("keydown", problemKeyListener, true);
  }

  function scheduleProblemClose() {
    if (!problemPopover) return;
    clearTimeout(problemCloseTimer);
    problemCloseTimer = setTimeout(() => {
      if (problemPinned || problemPopover?.matches(":hover") || problemPopover?.contains(document.activeElement) || problemTrigger.contains(document.activeElement)) return;
      closeProblemPopover();
    }, 120);
  }

  async function fixProblem(problem: ModProblem, how: string, button?: HTMLElement) {
    const instance = ctx.instance();
    if (how === "dependency") {
      if (problem.fix?.kind !== "install-dependency") return;
      const dependencyId = problem.fix.id;
      const started = await withBusy(button ?? body, () => guard(() => rpc("mods.installDependency", { instanceId: instance.id, dependencyId })));
      if (!started) return;
      toast(`开始安装前置 ${started.title}`, "ok");
      openDownloads(started.taskId);
      void awaitTask(started.taskId, signal).then(() => void load(true), () => undefined);
      return;
    }
    if (how === "enable") {
      if (problem.fix?.kind !== "enable-mod") return;
      const targets = problem.fix.files.map((file) => mods.find((mod) => mod.file === file)).filter((mod): mod is LocalMod => Boolean(mod));
      if (!targets.length) {
        toast("没有找到被禁用的前置文件，请到模组列表手动启用", "error");
        return;
      }
      for (const mod of targets) await guard(() => rpc("mods.setEnabled", { instanceId: instance.id, path: mod.path, enabled: true }));
      toast(`已启用 ${targets.length} 个前置文件`, "ok");
      scheduleReload();
      return;
    }
    if (how === "loader") {
      if (problem.fix?.kind !== "switch-loader") return;
      const { openCreate } = await import("./create");
      return openCreate({ mcVersion: instance.mcVersion, loaderKind: problem.fix.loader });
    }
    if (how === "dedupe") {
      const files = problem.files.map((file) => mods.find((mod) => mod.file === file || mod.path === file)).filter((mod): mod is LocalMod => Boolean(mod));
      if (files.length < 2) return;
      files.sort((a, b) => b.mtime - a.mtime);
      const [keep, ...rest] = files;
      const ok = await confirmDialog({ title: "只保留最新的一个？", message: html`<p style="margin:0;line-height:1.8">保留 <b>${keep.file}</b>，禁用：<br />${rest.map((mod) => html`<code>${mod.file}</code><br />`)}被禁用的文件只是改了扩展名，随时可以重新启用。</p>`, confirm: "禁用重复项" });
      if (!ok) return;
      for (const mod of rest) await guard(() => rpc("mods.setEnabled", { instanceId: instance.id, path: mod.path, enabled: false }));
      scheduleReload();
    }
  }

  // ------------------------------------------------------------------------------------------ actions
  async function toggle(mod: LocalMod) {
    const result = await guard(() => rpc("mods.setEnabled", { instanceId: ctx.instance().id, path: mod.path, enabled: mod.disabled }));
    if (!result) return;
    mod.disabled = !mod.disabled;
    mod.path = result.path;
    mod.file = result.path.split("/").pop() ?? mod.file;
    scheduleReload();
  }

  async function more(button: HTMLElement, mod: LocalMod) {
    const home = mod.meta?.homepage;
    const choice = await openMenu(button, [
      { id: "toggle", label: mod.disabled ? "启用" : "禁用" },
      { id: "home", label: "打开模组主页 ↗", disabled: !home },
      { id: "copy", label: "复制文件名" },
      { id: "remove", label: "删除这个文件", danger: true, divider: true },
    ]);
    if (choice === "toggle") return toggle(mod);
    if (choice === "home" && home) return openLink(home);
    if (choice === "copy") {
      await navigator.clipboard?.writeText(mod.file).catch(() => undefined);
      return toast("已复制文件名", "ok");
    }
    if (choice === "remove") {
      const ok = await confirmDialog({ title: "删除这个模组？", message: html`<p style="margin:0;line-height:1.8"><b>${mod.meta?.name ?? mod.file}</b><br /><span class="muted" style="font-size:12px">${mod.file}</span><br />文件会被永久删除（不进回收站）。</p>`, confirm: "删除", danger: true });
      if (!ok) return;
      if (await guard(() => rpc("mods.remove", { instanceId: ctx.instance().id, path: mod.path }).then(() => true))) {
        toast("已删除", "ok");
        scheduleReload();
      }
    }
  }

  function syncUpdateButton() {
    const button = body.querySelector<HTMLButtonElement>('[data-act="mods-check"]');
    if (!button) return;
    button.dataset.updates = String(updates.length);
    button.textContent = updates.length ? `更新 ${updates.length}` : "检查更新";
    button.title = updates.length ? `${updates.length} 个模组可以更新` : "检查 Modrinth 上的模组更新";
  }

  function openUpdatesDialog() {
    if (!updates.length) return;
    const rows = updates.map(
      (update, index) => html`<label class="mod-update-row">
        <input type="checkbox" data-u="${index}" checked />
        <span class="thumb" aria-hidden="true">${(update.title || "?").slice(0, 1).toUpperCase()}</span>
        <span class="mod-update-copy"><b>${update.title}</b><small>${update.currentVersion ?? "当前版本"} <span class="arrow">→</span> ${update.latest.versionNumber}</small></span>
        <span class="chip accent">可更新</span>
      </label>`,
    );
    const dialog = openDialog({
      eyebrow: "MOD UPDATES",
      title: `${updates.length} 个模组可以更新`,
      size: "wide",
      body: html`<div class="mod-update-list">${rows}</div><div class="muted mod-update-note">只显示 Modrinth 能通过文件哈希识别，并且与当前游戏版本和加载器兼容的更新。更新会下载新文件并替换旧文件。</div>`,
      buttons: [
        { id: "later", label: "稍后处理" },
        { id: "apply", label: "更新所选", kind: "accent" },
      ],
      onButton: async (id, handle) => {
        if (id !== "apply") return true;
        const chosen = updates.filter((_, index) => handle.body.querySelector<HTMLInputElement>(`[data-u="${index}"]`)?.checked);
        if (!chosen.length) {
          toast("没有选择任何模组", "info");
          return false;
        }
        const started = await withBusy(handle.button("apply") ?? handle.body, () => guard(() => rpc("content.applyUpdates", { instanceId: ctx.instance().id, updates: chosen })));
        if (!started) return false;
        updates = updates.filter((update) => !chosen.includes(update));
        syncUpdateButton();
        openDownloads(started.taskId);
        void awaitTask(started.taskId, signal).then(() => void load(true), () => undefined);
        return true;
      },
    });
    dialog.root.classList.add("mod-update-dialog");
    const rowElements = [...dialog.body.querySelectorAll<HTMLElement>(".mod-update-row")];
    void springReveal(rowElements, {
      origin: "bottom",
      distance: 20,
      stagger: 80,
      fromScale: 0.96,
      response: 0.34,
      dampingRatio: 0.8,
      force: currentSpringForce(),
    });
  }

  async function checkUpdates(button: HTMLElement) {
    const instance = ctx.instance();
    const started = await guard(() => rpc("content.checkUpdates", { instanceId: instance.id }));
    if (!started) return;
    await withBusy(button, async () => {
      try {
        const task = await awaitTask(started.taskId, signal);
        updates = Array.isArray(task.result) ? (task.result as ModUpdate[]) : [];
        syncUpdateButton();
        toast(updates.length ? `发现 ${updates.length} 个模组可以更新` : "所有模组都是最新的", updates.length ? "info" : "ok");
        if (updates.length) openUpdatesDialog();
      } catch (error) {
        if ((error as { code?: string }).code !== "cancelled") toast(`检查更新失败：${(error as Error).message}`, "error");
      }
    });
  }

  problemTrigger.addEventListener("pointerenter", () => showProblemPopover(false));
  problemTrigger.addEventListener("pointerleave", scheduleProblemClose);
  problemTrigger.addEventListener("focusin", () => {
    if (!problemFocusGuard) showProblemPopover(false);
  });
  problemTrigger.addEventListener("focusout", scheduleProblemClose);
  problemTrigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (problemPopover && problemPinned) return closeProblemPopover();
    showProblemPopover(true);
  });

  // ------------------------------------------------------------------------------------------ wiring
  onAll(body, "input", "[data-q]", (element) => {
    query = (element as HTMLInputElement).value.trim().toLowerCase();
    applyFilter();
  });
  onAll(body, "click", "[data-filter] button", (element) => {
    filter = element.dataset.v as Filter;
    for (const button of $$("[data-filter] button", body)) button.setAttribute("aria-pressed", String(button === element));
    applyFilter();
  });
  onAll(body, "click", "[data-toggle]", (element) => {
    const mod = mods[Number(element.closest<HTMLElement>(".mod-row")?.dataset.i)];
    if (mod) void toggle(mod);
  });
  onAll(body, "click", "[data-more]", (element) => {
    const mod = mods[Number(element.closest<HTMLElement>(".mod-row")?.dataset.i)];
    if (mod) void more(element, mod);
  });
  onAll(body, "click", "[data-problem]", (element) => {
    const problem = problems[Number(element.dataset.problem)];
    if (problem) void fixProblem(problem, element.dataset.fix ?? "", element);
  });
  onAll(body, "click", "[data-act]", (element) => {
    switch (element.dataset.act) {
      case "mods-install":
        return void import("../content-browse").then(({ browseContent }) => browseContent({ kind: "mod", instanceId: ctx.instance().id }));
      case "mods-check":
        return updates.length ? openUpdatesDialog() : void checkUpdates(element);
      case "mods-folder":
        return void openFolder(ctx.instance().id, "mods");
      case "mods-reload":
        return void load();
    }
  });

  void load();
  return {
    update() {
      // New or removed jars (an install finished, the player changed the folder): reload quietly.
      if (loadedCount >= 0 && ctx.instance().modCount !== loadedCount) scheduleReload();
    },
    dispose() {
      clearTimeout(reloadTimer);
      observer?.disconnect();
      queue.length = 0;
      clearTimeout(problemCloseTimer);
      closeProblemPopover(true);
    },
  };
}
