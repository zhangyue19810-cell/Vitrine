import { rpc, tryRpc } from "../api";
import { guard, openFolder, openLink, repairInstance } from "../actions";
import { $, debounce, html, onAll, setHtml } from "../dom";
import { errorMessage, formatBytes } from "../format";
import { openSheet, toast } from "../modal";
import { displayName } from "../records";
import { store } from "../store";
import type { CrashAnalysis, CrashFinding, CrashFix, GameLine, GameSnapshot, InstanceSummary } from "../types";

/**
 * The game's console output (live while it runs) and the crash analysis. Both are used on the instance page and in a
 * sheet that opens from the home screen or when a game crashes.
 */

const MAX_ROWS = 2000;

type Level = "error" | "warn" | "debug" | "info";

export function levelOf(text: string): Level {
  if (/\b(ERROR|FATAL|SEVERE)\b|^\s*(Exception|java\.|Caused by:)|^\s+at [\w.$<>]+\(/.test(text)) return "error";
  if (/\bWARN(ING)?\b/.test(text)) return "warn";
  if (/\b(DEBUG|TRACE)\b/.test(text)) return "debug";
  return "info";
}

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The game most worth showing for an instance: the running one, else the latest this session. */
export function gameFor(instanceId: string): GameSnapshot | undefined {
  return store.gameList().find((game) => game.instanceId === instanceId);
}

// ---------------------------------------------------------------------------------------------- log viewer

export interface LogViewerHandle {
  dispose(): void;
  /** Called when the game of the instance changed (a new run started). */
  retarget(): void;
}

export function mountLogViewer(host: HTMLElement, instanceId: string): LogViewerHandle {
  host.innerHTML = `<div class="stack" style="gap:10px;height:100%;min-height:0">
    <div class="toolbar">
      <div class="search-input grow"><input class="input" data-q placeholder="筛选日志…" autocomplete="off" /></div>
      <div class="seg" data-level><button data-v="debug" aria-pressed="false">全部</button><button data-v="info" aria-pressed="true">信息</button><button data-v="warn" aria-pressed="false">警告</button><button data-v="error" aria-pressed="false">错误</button></div>
    </div>
    <div class="toolbar"><span class="muted" data-f="state" style="font-size:12px"></span><span class="grow"></span><label class="check"><input type="checkbox" data-follow checked />自动滚动</label><button class="btn sm soft" data-act="log-copy">复制全部</button><button class="btn sm soft" data-act="log-folder">打开日志文件夹</button></div>
    <div class="logview" data-f="view" tabindex="0" aria-label="游戏日志" aria-live="off"></div>
  </div>`;
  const view = $<HTMLElement>("[data-f='view']", host);
  const stateText = $<HTMLElement>("[data-f='state']", host);
  let game = gameFor(instanceId);
  let gameId = game?.id;
  let minLevel: Level = "info";
  let query = "";
  let follow = true;
  let last: GameLine | undefined;
  let scheduled = 0;
  let disposed = false;

  const lines = (): GameLine[] => (gameId ? (store.gameLines.get(gameId) ?? []) : []);
  const visible = (line: GameLine) => LEVEL_RANK[levelOf(line.text)] >= LEVEL_RANK[minLevel] && (!query || line.text.toLowerCase().includes(query));

  const makeRow = (line: GameLine) => {
    const row = document.createElement("div");
    row.className = "logline";
    row.dataset.lvl = levelOf(line.text);
    row.textContent = line.text;
    return row;
  };

  const paintState = () => {
    game = gameFor(instanceId);
    const text = !game
      ? "这次打开启动器后还没有启动过这个实例"
      : game.state === "exited"
        ? `游戏已退出${game.exitCode !== null && game.exitCode !== undefined ? `（退出码 ${game.exitCode}）` : ""}${game.stoppedByUser ? " · 手动结束" : ""}`
        : game.state === "starting"
          ? "游戏正在启动…"
          : "游戏运行中";
    if (stateText.textContent !== text) stateText.textContent = text;
  };

  const renderAll = () => {
    view.textContent = "";
    last = undefined;
    const all = lines();
    const fragment = document.createDocumentFragment();
    let count = 0;
    for (const line of all) {
      if (visible(line)) {
        fragment.append(makeRow(line));
        count++;
      }
      last = line;
    }
    while (count > MAX_ROWS) {
      fragment.removeChild(fragment.firstChild!);
      count--;
    }
    view.append(fragment);
    if (!all.length) view.innerHTML = `<div class="logline" data-lvl="debug">${gameId ? "还没有输出。" : "启动游戏后，控制台输出会实时显示在这里。"}</div>`;
    if (follow) view.scrollTop = view.scrollHeight;
  };

  const flush = () => {
    scheduled = 0;
    if (disposed) return;
    paintState();
    const all = lines();
    const from = last ? all.lastIndexOf(last) : -1;
    if (last && from < 0) return renderAll(); // the buffer moved past what we drew
    const fresh = all.slice(from + 1);
    if (!fresh.length) return;
    if (view.firstElementChild && !view.querySelector("[data-lvl='error'], [data-lvl='warn'], [data-lvl='info']")) view.textContent = "";
    const fragment = document.createDocumentFragment();
    for (const line of fresh) if (visible(line)) fragment.append(makeRow(line));
    last = fresh[fresh.length - 1];
    view.append(fragment);
    while (view.childElementCount > MAX_ROWS) view.firstElementChild!.remove();
    if (follow) view.scrollTop = view.scrollHeight;
  };

  // Batch bursts of output (a crashing game prints thousands of lines) into one paint per frame.
  const schedule = () => {
    if (!scheduled && !disposed) scheduled = requestAnimationFrame(flush);
  };

  const seed = async () => {
    if (!gameId || lines().length) return;
    const tail = await tryRpc("games.tail", { id: gameId, count: 2000 });
    if (tail && !disposed && !lines().length) {
      store.gameLines.set(gameId, tail);
      renderAll();
    }
  };

  const off = [
    store.on<string>("game-lines", (id) => id === gameId && schedule()),
    store.on("games", () => {
      const current = gameFor(instanceId);
      if (current?.id !== gameId) {
        gameId = current?.id;
        renderAll();
        void seed();
      }
      paintState();
    }),
  ];

  view.addEventListener("scroll", () => {
    follow = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    const box = host.querySelector<HTMLInputElement>("[data-follow]");
    if (box) box.checked = follow;
  });
  onAll(host, "change", "[data-follow]", (element) => {
    follow = (element as HTMLInputElement).checked;
    if (follow) view.scrollTop = view.scrollHeight;
  });
  const setQuery = debounce((value: string) => {
    query = value.trim().toLowerCase();
    renderAll();
  }, 200);
  onAll(host, "input", "[data-q]", (element) => setQuery((element as HTMLInputElement).value));
  onAll(host, "click", "[data-level] button", (element) => {
    minLevel = element.dataset.v as Level;
    for (const button of host.querySelectorAll("[data-level] button")) button.setAttribute("aria-pressed", String(button === element));
    renderAll();
  });
  onAll(host, "click", "[data-act]", async (element) => {
    if (element.dataset.act === "log-folder") return openFolder(instanceId, "logs");
    if (element.dataset.act === "log-copy") {
      const text = lines().map((line) => line.text).join("\n");
      if (!text) return toast("没有可复制的日志", "info");
      try {
        await navigator.clipboard.writeText(text);
        toast(`已复制 ${lines().length} 行日志`, "ok");
      } catch {
        toast("浏览器不允许写入剪贴板", "error");
      }
    }
  });

  paintState();
  renderAll();
  void seed();
  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(scheduled);
      setQuery.cancel();
      for (const stop of off) stop();
    },
    retarget() {
      gameId = gameFor(instanceId)?.id;
      renderAll();
      void seed();
    },
  };
}

// ---------------------------------------------------------------------------------------------- crash analysis

const SEVERITY_LABEL: Record<string, string> = { error: "问题", warn: "可能的原因", info: "提示" };

const DRIVER_PAGE: Record<string, string> = {
  nvidia: "https://www.nvidia.cn/Download/index.aspx",
  amd: "https://www.amd.com/zh-cn/support/download/drivers.html",
  intel: "https://www.intel.cn/content/www/cn/zh/download-center/home.html",
};

function fixLabel(fix: CrashFix): string | undefined {
  switch (fix.kind) {
    case "increase-memory":
      return fix.suggestMb ? `把内存调到 ${(fix.suggestMb / 1024).toFixed(fix.suggestMb % 1024 ? 1 : 0)} GB` : "调整内存";
    case "switch-java":
      return `改用 Java ${fix.major}`;
    case "install-mods":
      return "一键补齐前置";
    case "disable-mods":
      return "禁用有问题的模组";
    case "remove-duplicates":
      return "清理重复的模组";
    case "repair-files":
      return "校验并修复文件";
    case "update-graphics-driver":
      return "打开显卡驱动下载页";
    case "reset-jvm-args":
      return "恢复默认 JVM 参数";
    case "check-config":
      return "打开配置文件夹";
    case "change-game-version":
      return `新建 ${fix.wanted} 的实例`;
    case "switch-loader":
      return `新建 ${fix.loader} 加载器实例`;
    case "free-disk-space":
      return undefined;
  }
}

export function renderCrash(host: HTMLElement, analysis: CrashAnalysis, instance: InstanceSummary, options: { onFixed?: () => void; goMods?: () => void } = {}) {
  const findings = analysis.findings;
  setHtml(
    host,
    html`<div class="stack" style="gap:14px">
      <div class="crash-summary"><b>${analysis.summary}</b>${analysis.description ? html`<div class="muted" style="margin-top:6px;font-size:12.5px">当时游戏正在：${analysis.description}</div>` : ""}${analysis.rootException ? html`<div class="mono" style="margin-top:8px;font-size:11.5px;overflow-wrap:anywhere;opacity:.8">${analysis.rootException}</div>` : ""}</div>
      ${analysis.suspectedMods.length ? html`<div class="notice warn"><div><b>可疑的模组</b><div style="margin-top:4px">${analysis.suspectedMods.join("、")}</div></div></div>` : ""}
      ${findings.length ? html`<div class="stack" style="gap:10px">${findings.map((finding, index) => findingCard(finding, index))}</div>` : html`<div class="empty"><b>没有匹配到已知的原因</b><div>把日志或下面的诊断信息发给整合包作者或模组作者通常能最快定位。</div></div>`}
      <div class="toolbar"><button class="btn sm soft" data-crash="copy">复制诊断信息</button><button class="btn sm soft" data-crash="folder">打开崩溃报告文件夹</button></div>
    </div>`,
  );
  onceDelegate(host, async (element) => {
    const kind = element.dataset.crash;
    if (kind === "copy") {
      try {
        await navigator.clipboard.writeText(diagnostics(analysis, instance));
        toast("已复制，可以直接粘贴给别人看", "ok");
      } catch {
        toast("浏览器不允许写入剪贴板", "error");
      }
    } else if (kind === "folder") await openFolder(instance.id, "crash-reports");
    else if (kind === "fix") {
      const finding = findings[Number(element.dataset.i)];
      if (finding?.fix) await applyFix(finding.fix, instance, options);
    }
  });
}

function findingCard(finding: CrashFinding, index: number) {
  const label = finding.fix ? fixLabel(finding.fix) : undefined;
  return html`<div class="crash-finding" data-sev="${finding.severity}">
    <h4><span class="chip ${finding.severity === "error" ? "danger" : finding.severity === "warn" ? "warn" : ""}" style="margin-right:8px">${SEVERITY_LABEL[finding.severity] ?? finding.severity}</span>${finding.title}</h4>
    <p>${finding.detail}</p>
    ${finding.advice.length ? html`<ul>${finding.advice.map((line) => html`<li>${line}</li>`)}</ul>` : ""}
    ${finding.mods?.length ? html`<p class="muted">相关模组：${finding.mods.join("、")}</p>` : ""}
    ${finding.evidence ? html`<p class="mono muted" style="font-size:11px;overflow-wrap:anywhere">${finding.evidence}</p>` : ""}
    ${label ? html`<div class="fixes"><button class="btn sm accent" data-crash="fix" data-i="${index}">${label}</button></div>` : ""}
  </div>`;
}

function diagnostics(analysis: CrashAnalysis, instance: InstanceSummary): string {
  const loader = instance.loaders.filter((entry) => entry.kind !== "none").map((entry) => `${entry.kind}${entry.version ? ` ${entry.version}` : ""}`).join(" + ") || "原版";
  const lines = [
    `# ${displayName(instance)} 崩溃诊断`,
    `Minecraft ${instance.mcVersion ?? "?"} · ${loader} · Java ${instance.javaMajor ?? "?"} · ${instance.modCount} 个模组`,
    `系统：${store.system.os.name} ${store.system.os.arch} · 内存 ${(store.system.totalMemoryMB / 1024).toFixed(1)} GB · 启动器 ${store.system.version}`,
    "",
    `结论：${analysis.summary}`,
    analysis.description ? `游戏当时在：${analysis.description}` : "",
    analysis.rootException ? `根异常：${analysis.rootException}` : "",
    analysis.suspectedMods.length ? `可疑模组：${analysis.suspectedMods.join(", ")}` : "",
    "",
    ...analysis.findings.flatMap((finding) => [`- [${finding.severity}] ${finding.title}`, `  ${finding.detail}`, ...(finding.evidence ? [`  证据：${finding.evidence}`] : [])]),
  ];
  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

/** One delegated click handler per host (rendering again replaces the content, not the handler). */
const wired = new WeakMap<HTMLElement, (element: HTMLElement) => void | Promise<void>>();
function onceDelegate(host: HTMLElement, handler: (element: HTMLElement) => void | Promise<void>) {
  const had = wired.has(host);
  wired.set(host, handler);
  if (had) return;
  host.addEventListener("click", (event) => {
    const element = (event.target as Element).closest<HTMLElement>("[data-crash]");
    if (element && host.contains(element)) void wired.get(host)?.(element);
  });
}

async function applyFix(fix: CrashFix, instance: InstanceSummary, options: { onFixed?: () => void; goMods?: () => void }) {
  const id = instance.id;
  switch (fix.kind) {
    case "increase-memory": {
      const memory = fix.suggestMb ?? Math.min(store.system.totalMemoryMB * 0.6, 8192);
      if (await guard(() => rpc("instances.setConfig", { id, patch: { memory: Math.round(memory / 256) * 256 } }).then(() => true))) toast(`内存已调整为 ${(memory / 1024).toFixed(1)} GB`, "ok");
      return options.onFixed?.();
    }
    case "switch-java": {
      const list = await guard(() => rpc("java.list"));
      const found = list?.find((java) => java.major === fix.major && java.is64);
      if (found) {
        if (await guard(() => rpc("instances.setConfig", { id, patch: { javaPath: found.path } }).then(() => true))) toast(`已改用 Java ${found.major}（${found.path}）`, "ok");
        return options.onFixed?.();
      }
      const { confirmDialog } = await import("../modal");
      if (await confirmDialog({ title: `下载 Java ${fix.major}？`, message: `这台电脑上没有找到 Java ${fix.major}。可以从 Mojang 官方运行时下载一份，只用于游戏。`, confirm: "下载" })) {
        const started = await guard(() => rpc("java.install", { major: fix.major }));
        if (started) (await import("./downloads")).openDownloads(started.taskId);
      }
      return;
    }
    case "install-mods": {
      const started: { taskId: string; title: string }[] = [];
      for (const dependencyId of fix.modIds.slice(0, 8)) {
        try {
          started.push(await rpc("mods.installDependency", { instanceId: id, dependencyId }));
        } catch {
          /* try the next dependency; a manual fallback is offered below when none can be resolved */
        }
      }
      if (started.length) {
        toast(`开始安装 ${started.length} 个前置：${started.map((entry) => entry.title).join("、")}`, "ok");
        (await import("./downloads")).openDownloads(started[0].taskId);
        return options.onFixed?.();
      }
      toast("没有自动找到完全匹配的前置，已打开搜索", "info");
      const { openBrowse } = await import("./browse");
      return openBrowse({ kind: "mod", instanceId: id, query: fix.modIds[0] });
    }
    case "disable-mods":
    case "remove-duplicates": {
      const result = await guard(() => rpc("mods.list", { instanceId: id }));
      if (!result) return;
      const ids = new Set(fix.modIds.map((entry) => entry.toLowerCase()));
      const files = new Set((fix.kind === "disable-mods" ? (fix.files ?? []) : []).map((entry) => entry.toLowerCase()));
      let targets = result.mods.filter((mod) => !mod.disabled && (files.has(mod.file.toLowerCase()) || (mod.meta?.id && ids.has(mod.meta.id.toLowerCase())) || mod.meta?.provides.some((entry) => ids.has(entry.toLowerCase()))));
      if (fix.kind === "remove-duplicates") {
        const byId = new Map<string, typeof targets>();
        for (const mod of targets) byId.set(mod.meta?.id ?? mod.file, [...(byId.get(mod.meta?.id ?? mod.file) ?? []), mod]);
        targets = [...byId.values()].flatMap((group) => group.sort((a, b) => b.mtime - a.mtime).slice(1));
      }
      if (!targets.length) {
        toast("没有找到对应的模组文件，请到“模组”页手动处理", "info");
        return options.goMods?.();
      }
      const { confirmDialog } = await import("../modal");
      const ok = await confirmDialog({ title: fix.kind === "disable-mods" ? "禁用这些模组？" : "禁用重复的旧版本？", message: html`<p style="margin:0;line-height:1.8">${targets.map((mod) => html`<code>${mod.file}</code> <span class="muted">${formatBytes(mod.size)}</span><br />`)}被禁用的文件只是加了 .disabled 后缀，可以在“模组”页重新启用。</p>`, confirm: "禁用" });
      if (!ok) return;
      for (const mod of targets) await guard(() => rpc("mods.setEnabled", { instanceId: id, path: mod.path, enabled: false }));
      toast(`已禁用 ${targets.length} 个文件`, "ok");
      return options.onFixed?.();
    }
    case "repair-files":
      return repairInstance(id, "hash");
    case "update-graphics-driver": {
      const vendor = (fix.vendor ?? "").toLowerCase();
      const page = Object.entries(DRIVER_PAGE).find(([name]) => vendor.includes(name))?.[1] ?? DRIVER_PAGE.nvidia;
      return openLink(page);
    }
    case "reset-jvm-args":
      if (await guard(() => rpc("instances.setConfig", { id, patch: { jvmArgs: "", jvmPreset: null } }).then(() => true))) toast("已恢复默认 JVM 参数", "ok");
      return options.onFixed?.();
    case "check-config":
      return openFolder(id, "config");
    case "change-game-version": {
      const { openCreate } = await import("./create");
      return openCreate({ mcVersion: fix.wanted });
    }
    case "switch-loader": {
      const { openCreate } = await import("./create");
      return openCreate({ mcVersion: instance.mcVersion, loaderKind: fix.loader });
    }
    case "free-disk-space":
      return;
  }
}

/** Run the analysis (the core reads crash reports, latest.log and hs_err files from disk) and show it in `host`. */
export async function loadCrash(host: HTMLElement, instance: InstanceSummary, options: { game?: GameSnapshot; onFixed?: () => void; goMods?: () => void; signal?: AbortSignal } = {}) {
  const ready = options.game?.crash?.analysis;
  if (ready) return renderCrash(host, ready, instance, options);
  setHtml(host, html`<div class="skeleton" style="height:90px;margin-bottom:8px"></div><div class="skeleton" style="height:120px"></div>`);
  try {
    const analysis = await rpc("instances.analyzeCrash", { id: instance.id }, options.signal);
    if (options.signal?.aborted) return;
    renderCrash(host, analysis, instance, options);
  } catch (error) {
    if (options.signal?.aborted) return;
    setHtml(host, html`<div class="empty"><b>没有可分析的内容</b><div>${errorMessage(error)}</div><div class="muted" style="font-size:12px">游戏崩溃后会留下 crash-reports 里的报告和 logs/latest.log，分析会读取它们。</div></div>`);
  }
}

// ---------------------------------------------------------------------------------------------- sheet

export function openLogs(instanceId: string, options: { crash?: boolean } = {}) {
  const instance = store.instance(instanceId);
  if (!instance) return;
  const sheet = openSheet({ eyebrow: "GAME LOG", title: displayName(instance) });
  sheet.body.innerHTML = `<div style="display:flex;flex-direction:column;gap:14px;height:100%;min-height:0">
    <div class="tabs" role="tablist"><button role="tab" data-t="log" aria-selected="true">控制台日志</button><button role="tab" data-t="crash" aria-selected="false">崩溃分析</button></div>
    <div data-f="log" style="flex:1;min-height:0"></div>
    <div data-f="crash" style="flex:1;min-height:0;overflow:auto" hidden></div>
  </div>`;
  const logHost = $<HTMLElement>("[data-f='log']", sheet.body);
  const crashHost = $<HTMLElement>("[data-f='crash']", sheet.body);
  const viewer = mountLogViewer(logHost, instanceId);
  let crashLoaded = false;
  const controller = new AbortController();
  const select = (tab: "log" | "crash") => {
    for (const button of sheet.body.querySelectorAll<HTMLElement>("[data-t]")) button.setAttribute("aria-selected", String(button.dataset.t === tab));
    logHost.hidden = tab !== "log";
    crashHost.hidden = tab !== "crash";
    if (tab === "crash" && !crashLoaded) {
      crashLoaded = true;
      const current = store.instance(instanceId) ?? instance;
      void loadCrash(crashHost, current, { game: gameFor(instanceId), signal: controller.signal, onFixed: () => (crashLoaded = false) });
    }
  };
  onAll(sheet.body, "click", "[data-t]", (element) => select(element.dataset.t as "log" | "crash"));
  void sheet.closed.then(() => {
    controller.abort();
    viewer.dispose();
  });
  if (options.crash) select("crash");
}
