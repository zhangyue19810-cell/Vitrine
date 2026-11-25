import { markSvg } from "../brand";
import { formatSpeed } from "./format";
import type { MusicPlayer, PlayerChange } from "./music/player";
import type { TaskSnapshot } from "./types";

/**
 * The top quick island, ported from the spring geometry of Lumina UI's
 * IslandChat: width, height, vertical position and alpha each have their own
 * damped spring, so opening, collapsing to the small sensor bar and leaving
 * all overshoot and settle instead of snapping between CSS sizes.
 *
 * Launcher behaviour:
 *  - input opens the island for five seconds, then it rests as a compact bar;
 *  - ten seconds after the last real input it leaves completely (burn-in);
 *  - a finished download opens for exactly three seconds, then collapses to
 *    the sensor bar and leaves with the same ten-second rule;
 *  - active transfers and lyrics update content without resetting inactivity.
 */

const IDLE_HIDE_MS = 10_000;
const OPEN_HOLD_MS = 5_000;
const COMPLETE_HOLD_MS = 3_000;
const FAIL_HOLD_MS = 5_000;
const BAR_W = 58;
const BAR_H = 13;

type IslandMode = "idle" | "music" | "download" | "complete" | "error";
type IslandState = "hidden" | "bar" | "open";

export interface DynamicIslandActions {
  downloads(): void;
  music(): void;
  customDownload(): void;
}

const percentOf = (task: TaskSnapshot | undefined): number => {
  if (!task) return 0;
  if (task.state === "done") return 1;
  return Math.max(0, Math.min(1, task.fraction ?? (task.progress && task.progress.bytesTotal > 0 ? task.progress.bytesDone / task.progress.bytesTotal : 0)));
};

/** Semi-implicit spring from the MC mod, in stage pixels. */
class Spring {
  value: number;
  velocity = 0;
  target: number;
  constructor(
    start: number,
    private readonly stiffness: number,
    private readonly damping: number,
  ) {
    this.value = start;
    this.target = start;
  }

  to(target: number) {
    this.target = target;
  }

  snap(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  step(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acceleration = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += acceleration * h;
      this.value += this.velocity * h;
    }
  }

  settled(epsilon = 0.015) {
    return Math.abs(this.value - this.target) < epsilon && Math.abs(this.velocity) < epsilon * 6;
  }
}

export class DynamicIsland {
  readonly root = document.createElement("button");
  private readonly mark = document.createElement("span");
  private readonly sensor = document.createElement("span");
  private readonly eyebrow = document.createElement("small");
  private readonly title = document.createElement("b");
  private readonly meta = document.createElement("span");
  private readonly lyrics = document.createElement("span");
  private readonly lyricPrev = document.createElement("span");
  private readonly lyricCurrent = document.createElement("strong");
  private readonly lyricNext = document.createElement("span");
  private readonly progress = document.createElement("i");
  private readonly progressTrack = document.createElement("span");
  private readonly offs: (() => void)[] = [];
  private readonly width = new Spring(BAR_W, 240, 19);
  private readonly height = new Spring(BAR_H, 240, 19);
  private readonly y = new Spring(-24, 200, 17);
  private readonly alpha = new Spring(0, 120, 16);
  private geometryFrame = 0;
  private lastFrame = 0;
  private state: IslandState = "hidden";
  private mode: IslandMode = "idle";
  private lastActivity = performance.now();
  private idleTimer = 0;
  private collapseTimer = 0;
  private lastPointerActivity = 0;
  private task?: TaskSnapshot;
  private musicKey = "";
  private lastLyricText = "";

  constructor(
    stage: HTMLElement,
    private readonly player: MusicPlayer,
    private readonly actions: DynamicIslandActions,
  ) {
    this.root.type = "button";
    this.root.className = "dynamic-island";
    this.root.dataset.mode = "idle";
    this.root.dataset.state = "hidden";
    this.root.dataset.visible = "false";
    this.root.setAttribute("aria-label", "Vitrine 灵动岛");
    this.root.setAttribute("aria-live", "polite");
    this.mark.className = "island-mark";
    this.mark.innerHTML = markSvg({ tight: true, label: "", className: "island-ring" });
    this.mark.setAttribute("aria-hidden", "true");
    this.sensor.className = "island-sensor";
    this.sensor.setAttribute("aria-hidden", "true");
    this.eyebrow.className = "island-eyebrow";
    this.title.className = "island-title";
    this.meta.className = "island-meta";
    this.lyrics.className = "island-lyrics";
    this.lyrics.append(this.lyricPrev, this.lyricCurrent, this.lyricNext);
    this.progressTrack.className = "island-progress";
    this.progressTrack.append(this.progress);
    this.root.append(this.mark, this.sensor, this.eyebrow, this.title, this.meta, this.lyrics, this.progressTrack);
    stage.append(this.root);

    this.root.addEventListener("click", () => this.activate());
    this.offs.push(player.subscribe((change) => this.onPlayer(change)));
    this.bindActivity();
    this.renderIdle();
    this.applyGeometry(true);
  }

  start() {
    this.touch();
  }

  /** A task event from the core. Launch tasks have their own full-screen UI. */
  onTask(task: TaskSnapshot) {
    if (task.kind === "launch") return;
    if (task.state === "queued" || task.state === "running") {
      this.task = task;
      if (this.mode === "complete" || this.mode === "error") return;
      if (this.activeRecently()) {
        this.renderDownload(task);
        this.showOpenIfNotComplete();
      }
      return;
    }
    if (task.state === "done") {
      this.task = task;
      this.showResult(task, false);
    } else if (task.state === "failed") {
      this.task = task;
      this.showResult(task, true);
    } else if (task.state === "cancelled" && this.task?.id === task.id) {
      this.task = undefined;
      if (this.activeRecently()) this.refreshIdleMode();
    }
  }

  private activeRecently() {
    return performance.now() - this.lastActivity < IDLE_HIDE_MS;
  }

  private bindActivity() {
    const mark = (event: Event) => {
      if (event.type === "pointermove") {
        const now = performance.now();
        if (now - this.lastPointerActivity < 180) return;
        this.lastPointerActivity = now;
      }
      this.touch();
    };
    for (const name of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const) {
      window.addEventListener(name, mark, { passive: true });
      this.offs.push(() => window.removeEventListener(name, mark));
    }
    const visibility = () => {
      if (document.hidden) this.leave();
      else if (this.activeRecently()) this.touch();
    };
    document.addEventListener("visibilitychange", visibility);
    this.offs.push(() => document.removeEventListener("visibilitychange", visibility));
  }

  /** Real input opens the island for five seconds, then it becomes a quiet bar. */
  private touch() {
    this.lastActivity = performance.now();
    if (this.mode === "complete" || this.mode === "error") {
      // Let a completed task finish its announcement. Once it has left or
      // collapsed, a fresh input may open it again; the next click then
      // reaches the task manager.
      if (this.state === "hidden") {
        this.refreshIdleMode();
        this.state = "open";
        this.applyGeometry();
        this.schedulePhases();
      } else if (this.state === "bar") {
        this.state = "open";
        this.applyGeometry();
        this.schedulePhases();
      }
      return;
    }
    this.refreshIdleMode();
    this.state = "open";
    this.applyGeometry();
    this.schedulePhases();
  }

  private schedulePhases() {
    clearTimeout(this.collapseTimer);
    clearTimeout(this.idleTimer);
    this.collapseTimer = window.setTimeout(() => {
      if (!this.activeRecently() || this.state === "hidden") return;
      this.state = "bar";
      this.applyGeometry();
    }, OPEN_HOLD_MS);
    this.idleTimer = window.setTimeout(() => this.leave(), IDLE_HIDE_MS);
  }

  private showOpenIfNotComplete() {
    if (this.mode === "complete" || this.mode === "error") return;
    this.state = performance.now() - this.lastActivity < OPEN_HOLD_MS ? "open" : "bar";
    this.applyGeometry();
  }

  private leave() {
    if (this.state === "hidden") {
      this.applyGeometry();
      return;
    }
    clearTimeout(this.collapseTimer);
    this.state = "hidden";
    this.applyGeometry();
  }

  private setMode(mode: IslandMode) {
    this.mode = mode;
    this.root.dataset.mode = mode;
  }

  private refreshIdleMode() {
    const task = this.tasksCurrentlyActive()[0];
    if (task) {
      this.task = task;
      this.setMode("download");
      this.renderDownload(task);
      return;
    }
    if (this.player.state.playing && this.player.state.song) {
      this.setMode("music");
      this.renderMusic();
      return;
    }
    this.renderIdle();
  }

  private tasksCurrentlyActive(): TaskSnapshot[] {
    return this.task && (this.task.state === "running" || this.task.state === "queued") ? [this.task] : [];
  }

  private renderIdle() {
    this.setMode("idle");
    this.eyebrow.textContent = "VITRINE";
    this.title.textContent = "琉匣";
    this.meta.textContent = "点击新建下载";
    this.lyrics.hidden = true;
    this.progressTrack.hidden = true;
  }

  private renderDownload(task: TaskSnapshot) {
    this.setMode("download");
    const done = task.state === "done";
    const value = percentOf(task);
    const speed = task.progress?.speed ?? 0;
    this.eyebrow.textContent = done ? "COMPLETE" : "DOWNLOAD";
    this.title.textContent = task.title.replace(/^下载\s*/, "") || "自定义下载";
    this.meta.textContent = done
      ? "下载完成"
      : task.stageLabel
        ? `${task.stageLabel}${task.progress?.bytesTotal ? ` · ${Math.round(value * 100)}%` : ""}${speed > 0 ? ` · ${formatSpeed(speed)}` : ""}`
        : task.state === "queued"
          ? "等待下载…"
          : "正在准备…";
    this.lyrics.hidden = true;
    this.progressTrack.hidden = false;
    this.progress.style.width = `${Math.round(value * 1000) / 10}%`;
    this.root.dataset.progress = String(value);
  }

  private renderMusic() {
    const state = this.player.state;
    const song = state.song;
    if (!song) return this.renderIdle();
    this.setMode("music");
    this.eyebrow.textContent = `${state.playing ? "NOW PLAYING" : "PAUSED"} · ${song.name}`;
    this.title.textContent = song.name;
    this.meta.textContent = song.artists.join(" / ");
    const lines = state.lyrics?.lines ?? [];
    const index = state.lyricIndex;
    if (lines.length) {
      const text = lines[index]?.text ?? song.name;
      this.lyrics.hidden = false;
      this.lyricPrev.textContent = index > 0 ? lines[index - 1]?.text ?? "" : "";
      this.lyricNext.textContent = index + 1 < lines.length ? lines[index + 1]?.text ?? "" : "";
      this.lyricCurrent.textContent = text;
      if (text && text !== this.lastLyricText) {
        this.lastLyricText = text;
        this.lyricCurrent.classList.remove("island-lyric-pop");
        void this.lyricCurrent.offsetWidth;
        this.lyricCurrent.classList.add("island-lyric-pop");
      }
    } else {
      this.lyrics.hidden = true;
    }
    this.progressTrack.hidden = true;
  }

  private onPlayer(change: PlayerChange) {
    if (change !== "song" && change !== "play" && change !== "lyric" && change !== "lyrics" && change !== "loading" && change !== "error" && change !== "queue") return;
    const state = this.player.state;
    const key = JSON.stringify([state.song?.id, state.playing, state.lyricIndex, state.lyrics?.lines[state.lyricIndex]?.text, state.loading, state.error]);
    if (key === this.musicKey) return;
    this.musicKey = key;
    if (this.mode === "complete" || this.mode === "error") return;
    if (state.playing && state.song) {
      if (this.activeRecently()) {
        this.renderMusic();
        if (change === "song" || change === "play") {
          this.state = "open";
          this.applyGeometry();
        }
      }
    } else if (this.mode === "music") {
      this.refreshIdleMode();
    }
  }

  /** Result announcement: three seconds open, then the small bar, then the normal idle leave. */
  private showResult(task: TaskSnapshot, failed: boolean) {
    clearTimeout(this.collapseTimer);
    clearTimeout(this.idleTimer);
    this.setMode(failed ? "error" : "complete");
    this.eyebrow.textContent = failed ? "FAILED" : "COMPLETE";
    this.title.textContent = task.title.replace(/^下载\s*/, "") || "下载任务";
    this.meta.textContent = failed ? task.error ?? "下载失败" : "下载完成 · 3 秒后收起";
    this.lyrics.hidden = true;
    this.progressTrack.hidden = false;
    this.progress.style.width = "100%";
    this.state = "open";
    this.applyGeometry();
    this.collapseTimer = window.setTimeout(() => {
      if (this.mode !== "complete" && this.mode !== "error") return;
      this.state = "bar";
      this.applyGeometry();
    }, failed ? FAIL_HOLD_MS : COMPLETE_HOLD_MS);
    this.idleTimer = window.setTimeout(() => this.leave(), IDLE_HIDE_MS);
  }

  private targetGeometry() {
    if (this.state === "hidden") return { w: BAR_W, h: BAR_H, y: -34, a: 0, r: 6.5 };
    if (this.state === "bar") return { w: BAR_W, h: BAR_H, y: 0, a: 1, r: 6.5 };
    const geometry: Record<IslandMode, { w: number; h: number }> = {
      idle: { w: 210, h: 43 },
      download: { w: 360, h: 46 },
      complete: { w: 270, h: 44 },
      error: { w: 320, h: 52 },
      music: { w: 540, h: 74 },
    };
    const wanted = geometry[this.mode];
    const available = Math.max(180, (this.root.parentElement?.clientWidth ?? 1352) - 32);
    return { ...wanted, w: Math.min(wanted.w, available), y: 0, a: 1, r: Math.min(wanted.h / 2, 15) };
  }

  private applyGeometry(immediate = false) {
    const target = this.targetGeometry();
    if (immediate) {
      this.width.snap(target.w);
      this.height.snap(target.h);
      this.y.snap(target.y);
      this.alpha.snap(target.a);
      this.paintGeometry(target.r);
      return;
    }
    this.width.to(target.w);
    this.height.to(target.h);
    this.y.to(target.y);
    this.alpha.to(target.a);
    this.root.dataset.state = this.state;
    this.root.dataset.visible = this.state === "hidden" ? "false" : "true";
    this.root.setAttribute("aria-hidden", this.state === "hidden" ? "true" : "false");
    this.root.style.pointerEvents = this.state === "hidden" ? "none" : "auto";
    if (!this.geometryFrame) {
      this.lastFrame = 0;
      this.geometryFrame = requestAnimationFrame(this.tickGeometry);
    }
  }

  private readonly tickGeometry = (now: number) => {
    this.geometryFrame = 0;
    const dt = this.lastFrame ? Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000)) : 1 / 60;
    this.lastFrame = now;
    this.width.step(dt);
    this.height.step(dt);
    this.y.step(dt);
    this.alpha.step(dt);
    this.paintGeometry();
    const settled = this.width.settled() && this.height.settled() && this.y.settled() && this.alpha.settled();
    if (!settled) this.geometryFrame = requestAnimationFrame(this.tickGeometry);
  };

  private paintGeometry(radius = Math.min(this.height.value / 2, 15)) {
    const style = this.root.style;
    style.setProperty("--island-w", `${this.width.value.toFixed(2)}px`);
    style.setProperty("--island-h", `${this.height.value.toFixed(2)}px`);
    style.setProperty("--island-y", `${this.y.value.toFixed(2)}px`);
    style.setProperty("--island-a", String(Math.max(0, Math.min(1, this.alpha.value)).toFixed(4)));
    style.setProperty("--island-r", `${radius.toFixed(2)}px`);
    if (this.state === "hidden" && this.alpha.value < 0.01) style.visibility = "hidden";
    else style.visibility = "visible";
  }

  private activate() {
    if (this.state === "hidden") {
      this.touch();
      return;
    }
    if (this.state === "bar") {
      this.touch();
      return;
    }
    if (this.mode === "download" || this.mode === "complete" || this.mode === "error") this.actions.downloads();
    else if (this.mode === "music") this.actions.music();
    else this.actions.customDownload();
  }

  dispose() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.collapseTimer);
    cancelAnimationFrame(this.geometryFrame);
    for (const off of this.offs.splice(0)) off();
    this.root.remove();
  }
}
