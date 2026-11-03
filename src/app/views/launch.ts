import { rpc } from "../api";
import { guard } from "../actions";
import { $maybe, html, setHtml } from "../dom";
import { formatBytes, formatDuration, formatSpeed } from "../format";
import { toast } from "../modal";
import { displayName } from "./../records";
import { sound } from "../sound";
import { store } from "../store";
import type { TaskSnapshot } from "../types";
import { markSvg } from "../../brand";

/**
 * The screen shown while a game starts: the stages of the launch (account, Java, files, natives…) as they happen, the
 * download state when files are missing, and what went wrong when something fails. It covers the whole stage, so the 3D
 * scene is not drawn behind it.
 */

interface Overlay {
  taskId: string;
  instanceId: string;
  root: HTMLElement;
  off: (() => void)[];
  closing: boolean;
  startedAt: number;
}

let overlay: Overlay | undefined;
const listeners = new Set<() => void>();

export const launchOverlay = {
  get open() {
    return !!overlay && !overlay.closing;
  },
  onChange(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  close,
};

const notify = () => listeners.forEach((listener) => listener());

/** Show the launch screen of the active launch task of an instance (no-op when none is running). */
export function showLaunchFor(instanceId: string) {
  const task = store.activeTasks().find((entry) => entry.kind === "launch" && entry.instanceId === instanceId);
  if (task) openLaunch(task.id, instanceId);
}

export function openLaunch(taskId: string, instanceId: string) {
  if (overlay && !overlay.closing) {
    if (overlay.taskId === taskId) return;
    close(true);
  }
  const host = document.querySelector<HTMLElement>("#launch-root");
  if (!host) return;
  const root = document.createElement("section");
  root.className = "launch";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "正在启动游戏");
  host.append(root);
  const state: Overlay = { taskId, instanceId, root, off: [], closing: false, startedAt: Date.now() };
  overlay = state;
  sound.play("launch");
  const instance = store.instance(instanceId);
  root.innerHTML = html`<div class="launch-card">
      <div class="head"><div class="mark" style="color:var(--ink)">${markSvg()}</div><div style="min-width:0"><div class="micro" data-f="eyebrow">LAUNCHING</div><h2 data-f="title">${instance ? displayName(instance) : "启动游戏"}</h2></div></div>
      <div class="launch-stages" data-f="stages"></div>
      <div data-f="progress"></div>
      <div data-f="error"></div>
      <div class="launch-foot"><span class="muted" style="font-size:12px" data-f="hint"></span><span class="grow"></span><button class="btn" data-f="details">下载详情</button><button class="btn danger" data-f="cancel">取消启动</button><button class="btn" data-f="dismiss" hidden>关闭</button></div>
    </div>`.value;
  const f = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-f="${name}"]`)!;
  f("details").addEventListener("click", async () => (await import("./downloads")).openDownloads(taskId));
  f("cancel").addEventListener("click", async () => {
    const task = store.tasks.get(taskId);
    if (task && (task.state === "running" || task.state === "queued")) await guard(() => rpc("tasks.cancel", { id: taskId }));
  });
  f("dismiss").addEventListener("click", () => close());
  root.addEventListener("keydown", (event) => event.key === "Escape" && close());

  state.off.push(
    store.on<TaskSnapshot>("task", (task) => task.id === taskId && paint()),
    store.on("tasks", paint),
    store.on<{ mode: string }>("after-launch", () => {
      // The host hides or minimises the window now; the launch screen has done its job.
      window.setTimeout(() => close(), 250);
    }),
  );
  notify();
  paint();

  function paint() {
    const task = store.tasks.get(taskId);
    if (!task || state.closing) return;
    f("title").textContent = task.title.replace(/^启动\s*/, "") || (instance ? displayName(instance) : "启动游戏");
    const running = task.state === "running" || task.state === "queued";
    f("cancel").hidden = !running;
    f("dismiss").hidden = running;
    f("details").hidden = !task.progress || task.progress.totalFiles === 0;
    setHtml(
      f("stages"),
      task.stages.length
        ? html`${task.stages.map((stage) => html`<div class="launch-stage" data-state="${stage.state}"><i class="mk">${stage.state === "done" ? "✓" : ""}</i><span>${stage.label}</span>${stage.state === "active" && task.stageDetail ? html`<span class="detail">${task.stageDetail}</span>` : ""}</div>`)}`
        : html`<div class="launch-stage" data-state="active"><i class="mk"></i><span>${task.stageLabel ?? "准备中…"}</span></div>`,
    );
    paintProgress(f("progress"), task);
    if (task.state === "done") {
      f("eyebrow").textContent = "STARTED";
      f("hint").textContent = "游戏进程已启动，窗口即将出现…";
      window.setTimeout(() => close(), 900);
    } else if (task.state === "failed") {
      f("eyebrow").textContent = "FAILED";
      sound.play("error");
      const accountProblem = /账户|账号|登录/.test(task.error ?? "") || ["expired", "invalid-credentials"].includes(task.errorCode ?? "");
      setHtml(
        f("error"),
        html`<div class="notice danger"><div style="flex:1"><b>启动失败</b><div style="margin-top:6px;white-space:pre-wrap;line-height:1.7">${task.error ?? "未知错误"}</div>
          <div class="toolbar" style="margin-top:12px">${accountProblem ? html`<button class="btn sm" data-act="open-accounts">打开账号管理</button>` : ""}<button class="btn sm soft" data-act="open-downloads">查看任务日志</button></div></div></div>`,
      );
      f("hint").textContent = "";
    } else if (task.state === "cancelled") {
      toast("已取消启动", "info");
      close();
    } else {
      f("hint").textContent = running ? `已用时 ${formatDuration((Date.now() - state.startedAt) / 1000)}` : "";
    }
  }
}

function paintProgress(host: HTMLElement, task: TaskSnapshot) {
  const progress = task.progress;
  if (!progress || progress.totalFiles === 0 || task.state !== "running") {
    if (host.childElementCount) setHtml(host, html``);
    return;
  }
  const done = progress.doneFiles + progress.skippedFiles;
  const active = progress.lanes.filter((lane) => lane.state !== "idle").length;
  if (!host.querySelector(".launch-progress")) {
    setHtml(host, html`<div class="launch-progress"><div class="bar thick"><i></i></div><div class="line"><span data-p="files"></span><span data-p="speed"></span></div><div class="lane-dots" data-p="dots" aria-hidden="true"></div></div>`);
  }
  const set = (key: string, text: string) => {
    const element = host.querySelector<HTMLElement>(`[data-p="${key}"]`);
    if (element && element.textContent !== text) element.textContent = text;
  };
  host.querySelector<HTMLElement>(".bar")!.style.setProperty("--p", String(Math.min(1, task.fraction ?? done / progress.totalFiles)));
  set("files", `补全游戏文件 ${done} / ${progress.totalFiles}${progress.bytesTotal ? ` · ${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}` : ""}`);
  set("speed", `${active} 线程 · ${formatSpeed(progress.speed)}${progress.eta ? ` · 剩余 ${formatDuration(progress.eta)}` : ""}`);
  const dots = host.querySelector<HTMLElement>("[data-p='dots']")!;
  if (dots.childElementCount !== progress.lanes.length) dots.innerHTML = "<i></i>".repeat(progress.lanes.length);
  progress.lanes.forEach((lane, index) => {
    const dot = dots.children[index] as HTMLElement | undefined;
    if (dot && dot.dataset.state !== lane.state) dot.dataset.state = lane.state;
  });
}

function close(immediate = false) {
  const current = overlay;
  if (!current || current.closing) return;
  current.closing = true;
  for (const off of current.off) off();
  overlay = undefined;
  notify();
  if (immediate) return current.root.remove();
  current.root.classList.add("leaving");
  setTimeout(() => current.root.remove(), 280);
}

/** Used by the home screen to know whether a launch screen can be reopened for an instance. */
export const hasLaunchScreen = () => !!$maybe(".launch");
