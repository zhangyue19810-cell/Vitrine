import { rpc } from "../api";
import { awaitTask, guard, openFolder, openLink, withBusy } from "../actions";
import { $, $$, Latest, html, onAll, setHtml } from "../dom";
import { formatBytes } from "../format";
import { openMenu } from "../menu";
import { confirmDialog, toast } from "../modal";
import type { LocalMod, ModProblem, ModUpdate } from "../types";
import { loaderLabel } from "../format";
import type { TabContext, TabHandle } from "./detail-types";
import { openDownloads } from "./downloads";

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
    <div class="toolbar"><button class="btn sm accent" data-act="mods-install">＋ 安装模组</button><button class="btn sm" data-act="mods-check">检查更新</button><button class="btn sm soft" data-act="mods-folder">打开 mods 文件夹</button><span class="muted grow" data-f="summary" style="font-size:12px;text-align:right"></span></div>
    <div data-f="updates"></div>
    <div data-f="problems"></div>
    <div data-f="list"><div class="skeleton" style="height:58px;margin-bottom:6px"></div><div class="skeleton" style="height:58px;margin-bottom:6px"></div><div class="skeleton" style="height:58px"></div></div>
  </div>`;
  const f = (name: string) => $(`[data-f="${name}"]`, body);
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
  function paintProblems() {
    const host = f("problems");
    if (!problems.length) return setHtml(host, html``);
    setHtml(
      host,
      html`<div><div class="section-title">需要注意（${problems.length}）</div>${problems.map((problem, index) => {
        const action = problem.kind === "duplicate"
          ? { how: "dedupe", label: "只留最新的" }
          : problem.fix?.kind === "install-dependency"
            ? { how: "dependency", label: "一键补齐" }
            : problem.fix?.kind === "enable-mod"
              ? { how: "enable", label: "启用前置" }
              : problem.fix?.kind === "switch-loader"
                ? { how: "loader", label: "更换加载器" }
                : undefined;
        return html`<div class="problem"><span class="chip warn" style="flex:none">${KIND_LABEL[problem.kind]}</span><div style="flex:1;min-width:0"><div>${problem.message}</div><div class="muted" style="font-size:11.5px;margin-top:3px;overflow-wrap:anywhere">${problem.files.join("、")}</div></div>${action ? html`<button class="btn sm" data-problem="${index}" data-fix="${action.how}">${action.label}</button>` : ""}</div>`;
      })}</div>`,
    );
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

  async function checkUpdates(button: HTMLElement) {
    const instance = ctx.instance();
    const started = await guard(() => rpc("content.checkUpdates", { instanceId: instance.id }));
    if (!started) return;
    await withBusy(button, async () => {
      try {
        const task = await awaitTask(started.taskId, signal);
        updates = Array.isArray(task.result) ? (task.result as ModUpdate[]) : [];
        paintUpdates();
        toast(updates.length ? `${updates.length} 个模组可以更新` : "所有模组都是最新的", updates.length ? "info" : "ok");
      } catch (error) {
        if ((error as { code?: string }).code !== "cancelled") toast(`检查更新失败：${(error as Error).message}`, "error");
      }
    });
  }

  function paintUpdates() {
    const host = f("updates");
    if (!updates.length) return setHtml(host, html``);
    setHtml(
      host,
      html`<div><div class="section-title">可更新（${updates.length}）<span class="actions"><button class="btn sm accent" data-act="mods-apply">更新所选</button></span></div><div class="list">${updates.map(
        (update, index) => html`<label class="item" style="cursor:pointer"><input type="checkbox" data-u="${index}" checked /><div style="min-width:0"><div class="title">${update.title}</div><div class="sub">${update.currentVersion ?? "当前版本"} → ${update.latest.versionNumber}</div></div></label>`,
      )}</div></div>`,
    );
  }

  async function applyUpdates(button: HTMLElement) {
    const chosen = updates.filter((_, index) => body.querySelector<HTMLInputElement>(`[data-u="${index}"]`)?.checked);
    if (!chosen.length) return toast("没有选择任何模组", "info");
    const started = await withBusy(button, () => guard(() => rpc("content.applyUpdates", { instanceId: ctx.instance().id, updates: chosen })));
    if (!started) return;
    updates = updates.filter((update) => !chosen.includes(update));
    paintUpdates();
    openDownloads(started.taskId);
    void awaitTask(started.taskId, signal).then(() => void load(true), () => undefined);
  }

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
        return void import("./browse").then(({ openBrowse }) => openBrowse({ kind: "mod", instanceId: ctx.instance().id }));
      case "mods-check":
        return void checkUpdates(element);
      case "mods-apply":
        return void applyUpdates(element);
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
    },
  };
}
