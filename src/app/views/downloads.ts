import { rpc, tryRpc } from "../api";
import { guard, openLink } from "../actions";
import { $, $$, html, onAll, setHtml } from "../dom";
import { formatBytes, formatDuration, formatSpeed, relativeTime } from "../format";
import { type ModalHandle, openSheet, toast } from "../modal";
import { store } from "../store";
import type { InstallContentResult, LaneState, PackInstallResult, TaskSnapshot } from "../types";

/**
 * Downloads and background tasks. The right-hand side of this page is the window onto the multi-threaded downloader:
 * one cell per download lane showing which file it is fetching, from which host, over how many parallel connections,
 * with the speed curve of the whole run underneath.
 */

const KIND_LABEL: Record<string, string> = { install: "安装", modpack: "整合包", content: "内容", repair: "修复", launch: "启动", java: "Java", export: "导出", update: "更新", import: "导入", other: "任务" };
const STATE_LABEL: Record<string, string> = { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消" };
const LANE_LABEL: Record<string, string> = { idle: "空闲", connecting: "连接", downloading: "下载", verifying: "校验", retrying: "重试" };

// ---------------------------------------------------------------------------------------------- speed history

interface Sample {
  t: number;
  v: number;
}
const history = new Map<string, Sample[]>();
const MAX_SAMPLES = 240;
let tracking = false;

/** Collect the speed of every running task (cheap: one number per 400 ms), so the curve is complete when the page opens. */
export function trackSpeeds() {
  if (tracking) return;
  tracking = true;
  store.on<TaskSnapshot>("task", (task) => {
    if (task.state !== "running" || !task.progress) return;
    const list = history.get(task.id) ?? [];
    const now = Date.now();
    const last = list[list.length - 1];
    if (last && now - last.t < 400) return;
    list.push({ t: now, v: task.progress.speed });
    if (list.length > MAX_SAMPLES) list.shift();
    history.set(task.id, list);
  });
  store.on("tasks", () => {
    for (const id of history.keys()) if (!store.tasks.has(id)) history.delete(id);
  });
}

// ---------------------------------------------------------------------------------------------- the page

interface Page {
  sheet: ModalHandle;
  selected?: string;
  /** Task the detail pane was last built for, and the state it showed (a finished task is rebuilt once). */
  built?: { id: string; state: string };
  lanes: Map<number, HTMLElement>;
  raf: number;
  dirty: { list: boolean; detail: boolean };
  off: (() => void)[];
  poll: ReturnType<typeof setInterval>;
}

let page: Page | undefined;

export function openDownloads(focusTaskId?: string) {
  if (page) {
    if (focusTaskId) select(focusTaskId);
    return;
  }
  const sheet = openSheet({
    eyebrow: "DOWNLOADS · 多线程下载",
    title: "下载与任务",
    tools: html`<button class="btn sm soft" data-act="dl-clear">清除已完成</button>`,
    onClose: () => {
      for (const off of current().off) off();
      cancelAnimationFrame(current().raf);
      clearInterval(current().poll);
      page = undefined;
    },
  });
  const state: Page = { sheet, lanes: new Map(), raf: 0, dirty: { list: true, detail: true }, off: [], poll: setInterval(() => undefined, 60_000) };
  page = state;
  sheet.body.innerHTML = `<div class="dl"><div class="dl-list" data-f="list"></div><div class="dl-detail" data-f="detail"></div></div>`;
  const first = focusTaskId ?? store.activeDownloads()[0]?.id ?? store.taskList()[0]?.id;
  state.selected = first;
  state.off.push(
    store.on("tasks", () => schedule(true, true)),
    store.on<TaskSnapshot>("task", (task) => schedule(task.state !== "running", task.id === state.selected)),
    store.on<string>("task-log", (id) => id === state.selected && schedule(false, true)),
  );
  // Event publication is intentionally throttled when the window is in the background. The
  // foreground details page polls the live task so bytes/speed keep moving even then.
  let polling = false;
  state.poll = setInterval(async () => {
    if (!page || polling) return;
    const id = page.selected;
    const current = id ? store.tasks.get(id) : undefined;
    if (!id || !current || (current.state !== "running" && current.state !== "queued")) return;
    polling = true;
    try {
      const fresh = await tryRpc("tasks.get", { id });
      if (fresh && page && page.selected === id) {
        store.tasks.set(fresh.id, fresh);
        store.emit("task", fresh);
        store.emit("tasks");
        schedule(false, true);
      }
    } finally {
      polling = false;
    }
  }, 700);
  onAll(sheet.body, "click", "[data-task]", (element) => select(element.dataset.task!));
  onAll(sheet.body, "click", "[data-link]", (element) => void openLink(element.dataset.link!));
  onAll(sheet.body, "click", "[data-cancel]", async (element) => {
    await guard(() => rpc("tasks.cancel", { id: element.dataset.cancel! }));
  });
  sheet.tools.addEventListener("click", async (event) => {
    if (!(event.target as Element).closest("[data-act='dl-clear']")) return;
    await guard(() => rpc("tasks.clear"));
    toast("已清除完成的任务", "info");
  });
  paint();
}

const current = (): Page => page!;

function select(id: string) {
  if (!page) return;
  page.selected = id;
  page.built = undefined;
  schedule(true, true);
}

function schedule(list: boolean, detail: boolean) {
  if (!page) return;
  page.dirty.list ||= list;
  page.dirty.detail ||= detail;
  if (page.raf) return;
  page.raf = requestAnimationFrame(() => {
    if (!page) return;
    page.raf = 0;
    paint();
  });
}

function paint() {
  if (!page) return;
  const root = page.sheet.body;
  const tasks = store.taskList();
  if (!page.selected || !store.tasks.has(page.selected)) page.selected = store.activeDownloads()[0]?.id ?? tasks[0]?.id;
  paintList(root, tasks);
  paintDetail(root, page.selected ? store.tasks.get(page.selected) : undefined);
  page.dirty = { list: false, detail: false };
}

// ---------------------------------------------------------------------------------------------- list

function paintList(root: HTMLElement, tasks: TaskSnapshot[]) {
  const list = $("[data-f='list']", root);
  if (!tasks.length) {
    setHtml(list, html`<div class="empty"><b>没有任务</b>安装游戏、导入整合包或下载模组后，进度会出现在这里。</div>`);
    list.dataset.ids = "";
    return;
  }
  // Rebuild only when the set or the order of tasks changed; otherwise patch the rows.
  const ids = tasks.map((task) => task.id).join(",");
  if (list.dataset.ids !== ids) {
    list.dataset.ids = ids;
    setHtml(
      list,
      html`${tasks.map(
        (task) => html`<button class="dl-task" data-task="${task.id}">
          <div class="t"><span>${task.title}</span><span class="chip">${KIND_LABEL[task.kind] ?? task.kind}</span></div>
          <div class="s" data-s></div>
          <div class="bar"><i></i></div>
        </button>`,
      )}`,
    );
  }
  for (const task of tasks) {
    const row = list.querySelector<HTMLElement>(`[data-task="${CSS.escape(task.id)}"]`);
    if (!row) continue;
    row.dataset.selected = String(task.id === page?.selected);
    const progress = task.progress;
    const fraction = task.state === "done" ? 1 : (task.fraction ?? 0);
    const sub =
      task.state === "running"
        ? `${task.stageLabel ?? "进行中"}${progress && progress.speed > 0 ? ` · ${formatSpeed(progress.speed)}` : ""}${task.fraction !== undefined ? ` · ${Math.round(fraction * 100)}%` : ""}`
        : task.state === "failed"
          ? (task.error ?? "失败")
          : `${STATE_LABEL[task.state]}${task.endedAt ? ` · ${relativeTime(task.endedAt)}` : ""}`;
    const s = row.querySelector<HTMLElement>("[data-s]")!;
    if (s.textContent !== sub) s.textContent = sub;
    const bar = row.querySelector<HTMLElement>(".bar")!;
    bar.style.setProperty("--p", fraction.toFixed(4));
    bar.dataset.indeterminate = String(task.state === "running" && task.fraction === undefined);
    bar.hidden = task.state === "queued";
  }
}

// ---------------------------------------------------------------------------------------------- detail

function paintDetail(root: HTMLElement, task: TaskSnapshot | undefined) {
  const detail = $("[data-f='detail']", root);
  if (!page) return;
  if (!task) {
    page.built = undefined;
    setHtml(detail, html`<div class="empty" style="min-height:300px"><b>选择左侧的任务查看详情</b>这里会显示每个下载线程正在取哪个文件、从哪个源下载。</div>`);
    return;
  }
  if (!page.built || page.built.id !== task.id || (page.built.state !== task.state && task.state !== "running")) {
    buildDetail(detail, task);
    page.built = { id: task.id, state: task.state };
    page.lanes.clear();
  }
  patchDetail(detail, task);
}

function buildDetail(detail: HTMLElement, task: TaskSnapshot) {
  const running = task.state === "running" || task.state === "queued";
  setHtml(
    detail,
    html`
    <div class="dl-top">
      <div class="row-flex"><span class="chip">${KIND_LABEL[task.kind] ?? task.kind}</span><span class="chip" data-f="state"></span><span class="grow"></span>${running ? html`<button class="btn sm danger" data-cancel="${task.id}">取消任务</button>` : ""}</div>
      <h3>${task.title}</h3>
      <div class="muted" style="margin-top:6px;font-size:13px" data-f="stage"></div>
    </div>
    <div class="bar thick" data-f="bar"><i></i></div>
    <div class="stats">
      <div class="stat"><div class="label">速度</div><div class="value" data-f="speed">—</div></div>
      <div class="stat"><div class="label">已下载</div><div class="value" data-f="bytes">—</div></div>
      <div class="stat"><div class="label">文件</div><div class="value" data-f="files">—</div></div>
      <div class="stat"><div class="label">剩余时间</div><div class="value" data-f="eta">—</div></div>
      <div class="stat"><div class="label">已用时间</div><div class="value" data-f="elapsed">—</div></div>
    </div>
    <div data-f="error"></div>
    <div data-f="result"></div>
    ${task.stages.length ? html`<div><div class="section-title">阶段</div><div class="stages" data-f="stages"></div></div>` : ""}
    <div data-f="lane-block"><div class="section-title">下载线程<span class="chip" data-f="lane-count"></span></div><div class="lanes" data-f="lanes"></div></div>
    <div><div class="section-title">速度曲线</div><canvas class="spark" data-f="spark"></canvas></div>
    ${task.warnings.length ? html`<div><div class="section-title">提示</div>${task.warnings.map((w) => html`<div class="problem">${w}</div>`)}</div>` : ""}
    <div><div class="section-title">日志</div><div class="log" data-f="log"></div></div>`,
  );
}

function setText(root: HTMLElement, field: string, value: string) {
  const element = root.querySelector<HTMLElement>(`[data-f="${field}"]`);
  if (element && element.textContent !== value) element.textContent = value;
}

function patchDetail(detail: HTMLElement, task: TaskSnapshot) {
  const progress = task.progress;
  const state = detail.querySelector<HTMLElement>("[data-f='state']");
  if (state) {
    state.textContent = STATE_LABEL[task.state];
    state.className = `chip ${task.state === "done" ? "ok" : task.state === "failed" ? "danger" : task.state === "running" ? "accent" : ""}`;
  }
  setText(detail, "stage", task.state === "failed" ? "任务失败" : task.stageLabel ? `${task.stageLabel}${task.stageDetail ? ` · ${task.stageDetail}` : ""}` : (STATE_LABEL[task.state] ?? ""));
  const fraction = task.state === "done" ? 1 : (task.fraction ?? 0);
  const bar = detail.querySelector<HTMLElement>("[data-f='bar']");
  if (bar) {
    bar.style.setProperty("--p", fraction.toFixed(4));
    bar.dataset.indeterminate = String(task.state === "running" && task.fraction === undefined);
  }
  if (progress) {
    setText(detail, "speed", task.state === "running" ? formatSpeed(progress.speed) : "—");
    setText(detail, "bytes", progress.bytesTotal > 0 ? `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}` : formatBytes(progress.bytesDone));
    const done = progress.doneFiles + progress.skippedFiles;
    setText(detail, "files", `${done} / ${progress.totalFiles}${progress.failedFiles ? `（失败 ${progress.failedFiles}）` : ""}`);
    setText(detail, "eta", task.state === "running" ? formatDuration(progress.eta) : "—");
    setText(detail, "elapsed", formatDuration(progress.elapsedMs / 1000));
  } else if (task.startedAt) {
    setText(detail, "elapsed", formatDuration(((task.endedAt ?? Date.now()) - task.startedAt) / 1000));
  }
  patchStages(detail, task);
  patchLanes(detail, task);
  paintSpark(detail.querySelector<HTMLCanvasElement>("[data-f='spark']"), task);
  patchOutcome(detail, task);
  const log = detail.querySelector<HTMLElement>("[data-f='log']");
  if (log) {
    const lines = store.taskLogs.get(task.id) ?? [];
    const text = lines.slice(-200).join("\n");
    if (log.textContent !== text) {
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
      log.textContent = text || "（暂无日志）";
      if (stick) log.scrollTop = log.scrollHeight;
    }
  }
}

function patchStages(detail: HTMLElement, task: TaskSnapshot) {
  const host = detail.querySelector<HTMLElement>("[data-f='stages']");
  if (!host) return;
  const signature = task.stages.map((stage) => `${stage.id}:${stage.state}`).join("|");
  if (host.dataset.sig === signature) return;
  host.dataset.sig = signature;
  setHtml(host, html`${task.stages.map((stage) => html`<span class="stage" data-state="${stage.state}"><i class="mk"></i>${stage.label}</span>`)}`);
}

function patchLanes(detail: HTMLElement, task: TaskSnapshot) {
  const block = detail.querySelector<HTMLElement>("[data-f='lane-block']");
  const host = detail.querySelector<HTMLElement>("[data-f='lanes']");
  if (!block || !host || !page) return;
  const lanes = task.progress?.lanes ?? [];
  const live = task.state === "running" && lanes.length > 0;
  block.hidden = !lanes.length && task.state !== "running";
  if (!lanes.length) {
    if (!host.childElementCount) setHtml(host, html`<div class="muted" style="grid-column:1/-1;font-size:12.5px;padding:8px 0">${task.state === "running" ? "正在准备下载队列…" : "这个任务没有产生文件下载。"}</div>`);
    return;
  }
  if (!page.lanes.size) host.textContent = "";
  for (const lane of lanes) {
    let cell = page.lanes.get(lane.lane);
    if (!cell) {
      cell = document.createElement("div");
      cell.className = "lane";
      cell.innerHTML = `<div class="top"><span data-l="no"></span><span class="parts" data-l="parts"></span></div><div class="name" data-l="name"></div><div class="meta" data-l="meta"></div><div class="bar"><i></i></div>`;
      host.append(cell);
      page.lanes.set(lane.lane, cell);
    }
    paintLane(cell, lane, live);
  }
  const active = lanes.filter((lane) => lane.state !== "idle").length;
  setText(detail, "lane-count", `${active} / ${lanes.length} 个线程工作中`);
}

function paintLane(cell: HTMLElement, lane: LaneState, live: boolean) {
  const state = live ? lane.state : "idle";
  if (cell.dataset.state !== state) cell.dataset.state = state;
  const set = (key: string, value: string) => {
    const element = cell.querySelector<HTMLElement>(`[data-l="${key}"]`)!;
    if (element.textContent !== value) element.textContent = value;
  };
  set("no", `L${String(lane.lane + 1).padStart(2, "0")} · ${LANE_LABEL[state] ?? state}${lane.attempt > 1 ? ` · 第 ${lane.attempt} 次` : ""}`);
  set("name", state === "idle" ? "—" : lane.label);
  set("meta", state === "idle" ? "" : `${lane.host}${lane.total > 0 ? ` · ${formatBytes(lane.received)} / ${formatBytes(lane.total)}` : lane.received ? ` · ${formatBytes(lane.received)}` : ""}`);
  const parts = cell.querySelector<HTMLElement>("[data-l='parts']")!;
  const count = state === "downloading" ? Math.max(1, Math.min(16, lane.parts)) : 0;
  if (parts.childElementCount !== count) parts.innerHTML = "<i></i>".repeat(count);
  const bar = cell.querySelector<HTMLElement>(".bar")!;
  bar.style.setProperty("--p", lane.total > 0 ? Math.min(1, lane.received / lane.total).toFixed(3) : "0");
  bar.hidden = state === "idle";
}

function patchOutcome(detail: HTMLElement, task: TaskSnapshot) {
  const error = detail.querySelector<HTMLElement>("[data-f='error']");
  if (error && task.state === "failed") {
    const accountProblem = /账户|账号|登录/.test(task.error ?? "") || ["expired", "invalid-credentials"].includes(task.errorCode ?? "");
    setHtml(error, html`<div class="notice danger"><div><b>任务失败</b><div style="margin-top:4px;white-space:pre-wrap">${task.error ?? "未知错误"}</div>${accountProblem ? html`<div style="margin-top:10px"><button class="btn sm" data-act="open-accounts">打开账号管理</button></div>` : ""}</div></div>`);
  } else if (error) setHtml(error, html``);
  const result = detail.querySelector<HTMLElement>("[data-f='result']");
  if (!result || result.dataset.shown === task.state) return;
  result.dataset.shown = task.state;
  const pack = task.state === "done" ? asPackResult(task.result) : undefined;
  if (!pack) {
    const content = task.state === "done" ? asContentResult(task.result) : undefined;
    const updated = task.state === "done" ? asUpdateApplyResult(task.result) : undefined;
    if (content) return setHtml(result, contentOutcome(content));
    if (updated) return setHtml(result, updateOutcome(updated));
    return setHtml(result, html``);
  }
  const problems = [...pack.failed.map((f) => ({ name: f.label ?? f.path, reason: f.error, url: f.pageUrl, restricted: f.restricted })), ...pack.unresolved.map((u) => ({ name: u.name ?? `项目 ${u.projectId} / 文件 ${u.fileId}`, reason: u.reason, url: u.pageUrl, restricted: false }))];
  setHtml(
    result,
    html`<div class="${pack.complete ? "notice" : "notice warn"}"><div style="flex:1">
      <b>${pack.complete ? "整合包安装完成" : "整合包已安装，但有文件缺失"}</b>
      <div style="margin-top:6px">${pack.name} · Minecraft ${pack.mcVersion} · 下载 ${pack.downloaded} 个文件，跳过 ${pack.skipped} 个已有文件，写入 ${pack.overrideFiles} 个覆盖文件</div>
      ${problems.length ? html`<div style="margin-top:10px">${problems.slice(0, 12).map((p) => html`<div style="margin:4px 0;font-size:12.5px">${p.restricted ? "需手动下载：" : "失败："}<b>${p.name}</b> <span class="muted">${p.reason}</span>${p.url ? html` <a class="link" data-link="${p.url}">打开页面</a>` : ""}</div>`)}${problems.length > 12 ? html`<div class="muted" style="font-size:12px">…还有 ${problems.length - 12} 项</div>` : ""}</div>` : ""}
    </div></div>`,
  );
}

function contentOutcome(result: InstallContentResult) {
  const bad = result.failed.length > 0;
  return html`<div class="${bad ? "notice warn" : "notice"}"><div style="flex:1">
    <b>${result.installed.length ? `已安装 ${result.installed.length} 项` : "没有安装任何内容"}${bad ? `，${result.failed.length} 项失败` : ""}</b>
    ${result.installed.length ? html`<div style="margin-top:6px;font-size:12.5px;line-height:1.8">${result.installed.slice(0, 20).map((item) => html`<div>${item.title} <span class="muted">${item.version}${item.dependency ? " · 前置" : ""}</span></div>`)}${result.installed.length > 20 ? html`<div class="muted">…还有 ${result.installed.length - 20} 项</div>` : ""}</div>` : ""}
    ${result.skipped.length ? html`<div style="margin-top:8px;font-size:12.5px">${result.skipped.map((item) => html`<div class="muted">跳过 ${item.title}：${item.reason}</div>`)}</div>` : ""}
    ${bad ? html`<div style="margin-top:8px;font-size:12.5px">${result.failed.map((item) => html`<div>失败：<b>${item.title}</b> <span class="muted">${item.error}</span>${item.pageUrl ? html` <a class="link" data-link="${item.pageUrl}">打开页面手动下载</a>` : ""}</div>`)}</div>` : ""}
  </div></div>`;
}

function updateOutcome(result: { updated: string[]; failed: { title: string; error: string }[] }) {
  return html`<div class="${result.failed.length ? "notice warn" : "notice"}"><div style="flex:1">
    <b>已更新 ${result.updated.length} 个模组${result.failed.length ? `，${result.failed.length} 个失败` : ""}</b>
    ${result.updated.length ? html`<div class="muted" style="margin-top:6px;font-size:12.5px;line-height:1.8">${result.updated.join("、")}</div>` : ""}
    ${result.failed.map((item) => html`<div style="margin-top:6px;font-size:12.5px">失败：<b>${item.title}</b> <span class="muted">${item.error}</span></div>`)}
  </div></div>`;
}

function asContentResult(value: unknown): InstallContentResult | undefined {
  const v = value as Partial<InstallContentResult> | undefined;
  return v && typeof v === "object" && Array.isArray(v.installed) && Array.isArray(v.skipped) && Array.isArray(v.failed) ? (v as InstallContentResult) : undefined;
}

function asUpdateApplyResult(value: unknown): { updated: string[]; failed: { title: string; error: string }[] } | undefined {
  const v = value as { updated?: unknown; failed?: unknown } | undefined;
  return v && typeof v === "object" && Array.isArray(v.updated) && Array.isArray(v.failed) && !("installed" in v) ? (v as { updated: string[]; failed: { title: string; error: string }[] }) : undefined;
}

function asPackResult(value: unknown): PackInstallResult | undefined {
  const v = value as Partial<PackInstallResult> | undefined;
  return v && typeof v === "object" && Array.isArray(v.failed) && Array.isArray(v.unresolved) && typeof v.totalFiles === "number" ? (v as PackInstallResult) : undefined;
}

// ---------------------------------------------------------------------------------------------- speed curve

function paintSpark(canvas: HTMLCanvasElement | null, task: TaskSnapshot) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#1f9e8e";
  const line = css.getPropertyValue("--line").trim() || "#aaa";
  const muted = css.getPropertyValue("--muted").trim() || "#777";
  ctx.clearRect(0, 0, width, height);
  const samples = history.get(task.id) ?? [];
  const pad = 8 * ratio;
  const top = 20 * ratio;
  ctx.strokeStyle = line;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = ratio;
  for (let i = 1; i < 4; i++) {
    const y = top + ((height - top - pad) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.font = `${10 * ratio}px sans-serif`;
  ctx.fillStyle = muted;
  if (samples.length < 2) {
    ctx.fillText(task.state === "running" ? "正在采集速度…" : "没有速度记录", pad, 14 * ratio);
    return;
  }
  const peak = Math.max(...samples.map((s) => s.v), 1) * 1.15;
  const t0 = samples[0].t;
  const span = Math.max(5000, samples[samples.length - 1].t - t0);
  const x = (t: number) => pad + ((t - t0) / span) * (width - pad * 2);
  const y = (v: number) => height - pad - (v / peak) * (height - top - pad);
  ctx.beginPath();
  ctx.moveTo(x(samples[0].t), height - pad);
  for (const s of samples) ctx.lineTo(x(s.t), y(s.v));
  ctx.lineTo(x(samples[samples.length - 1].t), height - pad);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, top, 0, height);
  fill.addColorStop(0, accent);
  fill.addColorStop(1, "transparent");
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.v)) : ctx.moveTo(x(s.t), y(s.v))));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6 * ratio;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fillStyle = muted;
  ctx.fillText(`峰值 ${formatSpeed(Math.max(...samples.map((s) => s.v)))}`, pad, 14 * ratio);
  const now = samples[samples.length - 1].v;
  const label = formatSpeed(now);
  ctx.textAlign = "right";
  ctx.fillText(label, width - pad, 14 * ratio);
}
