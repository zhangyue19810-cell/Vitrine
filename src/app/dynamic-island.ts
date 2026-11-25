import { markSvg } from "../brand";
import { formatSpeed } from "./format";
import type { MusicPlayer, PlayerChange } from "./music/player";
import type { TaskSnapshot } from "./types";

/**
 * The top quick island.
 *
 * It is deliberately not a permanent HUD: after ten seconds without real input
 * it slides away and stops all of its own motion, whether the launcher is in
 * the foreground or not. A running transfer or the current lyric can update it
 * while it is out, but progress alone never resets the burn-in timer. A finished
 * download is the one exception: it is held open for exactly three seconds so
 * the result can be read.
 */

const IDLE_HIDE_MS = 10_000;
const COMPLETE_HOLD_MS = 3_000;
const FAIL_HOLD_MS = 5_000;

type IslandMode = "idle" | "music" | "download" | "complete" | "error";

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

export class DynamicIsland {
  readonly root = document.createElement("button");
  private readonly mark = document.createElement("span");
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
  private visible = false;
  private mode: IslandMode = "idle";
  private lastActivity = performance.now();
  private idleTimer = 0;
  private holdTimer = 0;
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
    this.root.dataset.visible = "false";
    this.root.dataset.mode = "idle";
    this.root.setAttribute("aria-label", "Vitrine 灵动岛");
    this.root.setAttribute("aria-live", "polite");
    this.mark.className = "island-mark";
    this.mark.innerHTML = markSvg({ tight: true, label: "", className: "island-ring" });
    this.mark.setAttribute("aria-hidden", "true");
    this.eyebrow.className = "island-eyebrow";
    this.title.className = "island-title";
    this.meta.className = "island-meta";
    this.lyrics.className = "island-lyrics";
    this.lyrics.append(this.lyricPrev, this.lyricCurrent, this.lyricNext);
    this.progressTrack.className = "island-progress";
    this.progressTrack.append(this.progress);
    this.root.append(this.mark, this.eyebrow, this.title, this.meta, this.lyrics, this.progressTrack);
    // The title, eyebrow and metadata share a compact column; the icon and
    // lyric stack are positioned by CSS, so no flexible wrapper is needed.
    stage.append(this.root);

    this.root.addEventListener("click", () => this.activate());
    this.offs.push(player.subscribe((change) => this.onPlayer(change)));
    this.bindActivity();
    this.renderIdle();
    this.scheduleIdle();
  }

  start() {
    this.touch();
    this.renderIdle();
  }

  /** A task event from the core. Launch tasks have their own full-screen UI. */
  onTask(task: TaskSnapshot) {
    if (task.kind === "launch") return;
    if (task.state === "queued" || task.state === "running") {
      this.task = task;
      if (Date.now() - this.lastActivity < IDLE_HIDE_MS) {
        this.mode = "download";
        this.renderDownload(task);
        this.reveal(false);
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
      this.renderIdle();
    }
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
      if (document.hidden) this.hide();
      else this.scheduleIdle();
    };
    document.addEventListener("visibilitychange", visibility);
    this.offs.push(() => document.removeEventListener("visibilitychange", visibility));
  }

  private touch() {
    this.lastActivity = performance.now();
    if (this.mode !== "complete" && this.mode !== "error") this.refreshIdleMode();
    this.reveal(false);
    this.scheduleIdle();
  }

  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      // A completed/failed result has its own, shorter hold. Normal activity
      // always collapses after ten seconds even if media keeps changing.
      if (this.mode !== "complete" && this.mode !== "error") this.hide();
    }, IDLE_HIDE_MS);
  }

  private reveal(spring: boolean) {
    if (!this.visible) {
      this.visible = true;
      this.root.dataset.visible = "true";
    }
    if (spring) {
      this.root.classList.remove("island-spring");
      void this.root.offsetWidth;
      this.root.classList.add("island-spring");
    }
  }

  private hide() {
    this.visible = false;
    this.root.dataset.visible = "false";
    this.root.classList.remove("island-spring");
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

  /** Tasks are owned by the app; this small local list is refreshed by `task()`. */
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
      if (Date.now() - this.lastActivity < IDLE_HIDE_MS) {
        this.renderMusic();
        this.reveal(change === "song" || change === "play");
      }
    } else if (this.mode === "music") {
      this.refreshIdleMode();
    }
  }

  private showResult(task: TaskSnapshot, failed: boolean) {
    clearTimeout(this.holdTimer);
    this.setMode(failed ? "error" : "complete");
    this.eyebrow.textContent = failed ? "FAILED" : "COMPLETE";
    this.title.textContent = task.title.replace(/^下载\s*/, "") || "下载任务";
    this.meta.textContent = failed ? task.error ?? "下载失败" : "下载完成 · 3 秒后收起";
    this.lyrics.hidden = true;
    this.progressTrack.hidden = false;
    this.progress.style.width = "100%";
    this.visible = false;
    this.reveal(true);
    this.holdTimer = window.setTimeout(() => this.hide(), failed ? FAIL_HOLD_MS : COMPLETE_HOLD_MS);
  }

  private activate() {
    if (!this.visible) {
      this.touch();
      return;
    }
    if (this.mode === "download" || this.mode === "complete" || this.mode === "error") this.actions.downloads();
    else if (this.mode === "music") this.actions.music();
    else this.actions.customDownload();
  }

  dispose() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.holdTimer);
    for (const off of this.offs.splice(0)) off();
    this.root.remove();
  }
}
