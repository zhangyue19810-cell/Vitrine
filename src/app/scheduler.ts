import { RELEASE_AFTER_MS, decide, sameDecision, type PerfDecision, type PerfInputs } from "./perf-policy";

/**
 * Owns the animation-frame loop of the 3D scene.
 *
 * What to do in each situation lives in `perf-policy.ts`; this class feeds it the live inputs (window focus,
 * visibility, the player's activity, the game's state), keeps the loop running or stopped accordingly, throttles it to
 * the frame-rate ceiling, and gives GPU memory back when a game has been running behind a hidden launcher for a while.
 *
 * While the loop is stopped nothing is scheduled at all — no requestAnimationFrame, no interval — so a launcher that
 * sits in the tray behind a game costs nothing.
 */

export interface SchedulerHooks {
  /** Draw one frame; `time` is in seconds. */
  frame(time: number): void;
  /** The inputs that live outside the scheduler (settings, game state). */
  inputs(): Pick<PerfInputs, "gameRunning" | "launching" | "covered" | "fps" | "pauseWhenGameRuns" | "whenUnfocused" | "reducedMotion">;
  /** The decision changed (or this is the first one). */
  changed(next: PerfDecision, previous: PerfDecision | undefined): void;
  /** GPU memory may be freed: the scene has been paused behind a running game for a while. */
  release?(): void;
  /** The scene is needed again after a release. */
  restore?(): void;
}

export interface SchedulerStats {
  decision?: PerfDecision;
  focused: boolean;
  visible: boolean;
  frames: number;
  avgCostMs: number;
  avgIntervalMs: number;
  measuredHz?: number;
  released: boolean;
  transitions: { at: number; run: boolean; fps: number; reason: string; level: string }[];
}

const POKE_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export class RenderScheduler {
  private decision?: PerfDecision;
  private focused: boolean;
  private visible: boolean;
  private lastInput = performance.now();
  private raf = 0;
  private lastRaf = 0;
  private lastDraw = 0;
  private frames = 0;
  private cost = 0;
  private interval = 0;
  private idleTimer?: ReturnType<typeof setInterval>;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private released = false;
  private started = false;
  private rafDeltas: number[] = [];
  private displayHz?: number;
  private readonly transitions: SchedulerStats["transitions"] = [];
  private readonly abort = new AbortController();

  constructor(private readonly hooks: SchedulerHooks) {
    this.focused = document.hasFocus();
    this.visible = document.visibilityState !== "hidden";
  }

  start() {
    if (this.started) return;
    this.started = true;
    const { signal } = this.abort;
    window.addEventListener("focus", () => this.setWindowState({ focused: true }), { signal });
    window.addEventListener("blur", () => this.setWindowState({ focused: false }), { signal });
    document.addEventListener("visibilitychange", () => this.setWindowState({ visible: document.visibilityState !== "hidden" }), { signal });
    const poke = () => this.poke();
    for (const name of POKE_EVENTS) window.addEventListener(name, poke, { signal, passive: true, capture: true });
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => this.refresh(), { signal });
    this.refresh();
  }

  stop() {
    this.abort.abort();
    this.cancelLoop();
    clearInterval(this.idleTimer);
    clearTimeout(this.releaseTimer);
    this.started = false;
  }

  /** Window state pushed by the desktop shell (more reliable than DOM events for a minimised window). */
  setWindowState(state: { focused?: boolean; visible?: boolean }) {
    if (state.focused !== undefined) this.focused = state.focused;
    if (state.visible !== undefined) this.visible = state.visible;
    // The window cannot be focused while it is not visible.
    if (!this.visible) this.focused = false;
    this.refresh();
  }

  /** The player touched the window: leave any idle tier at once. */
  poke() {
    this.lastInput = performance.now();
    const reason = this.decision?.reason;
    if (reason === "idle" || reason === "idle-deep") this.refresh();
  }

  /** Recompute the decision from the current inputs (call after settings or game state change). */
  refresh() {
    if (!this.started) return;
    const inputs: PerfInputs = {
      visible: this.visible,
      focused: this.focused,
      idleMs: performance.now() - this.lastInput,
      displayHz: this.displayHz,
      ...this.hooks.inputs(),
    };
    const next = decide(inputs);
    if (sameDecision(this.decision, next)) return;
    const previous = this.decision;
    this.decision = next;
    this.transitions.push({ at: Math.round(performance.now()), run: next.run, fps: next.fps, reason: next.reason, level: next.level });
    if (this.transitions.length > 30) this.transitions.shift();
    this.apply(next, previous);
  }

  /** Draw one frame right now, regardless of the loop (used by tests and screenshots). */
  renderNow() {
    this.hooks.frame(performance.now() / 1000);
    this.frames++;
  }

  stats(): SchedulerStats {
    return {
      decision: this.decision,
      focused: this.focused,
      visible: this.visible,
      frames: this.frames,
      avgCostMs: Math.round(this.cost * 100) / 100,
      avgIntervalMs: Math.round(this.interval * 100) / 100,
      measuredHz: this.displayHz,
      released: this.released,
      transitions: [...this.transitions],
    };
  }

  get running() {
    return this.decision?.run ?? false;
  }

  /** The decision in force (cheap: no copy, safe to read every frame). */
  get current(): PerfDecision | undefined {
    return this.decision;
  }

  // ------------------------------------------------------------------------------------------ internals

  private apply(next: PerfDecision, previous: PerfDecision | undefined) {
    const root = document.documentElement;
    root.dataset.perf = next.reason;
    root.dataset.paused = String(!next.run);

    if (next.run) {
      if (!previous?.run) {
        this.lastDraw = 0;
        this.lastRaf = 0;
        this.scheduleLoop();
      }
      if (!this.idleTimer) this.idleTimer = setInterval(() => this.refresh(), 1000);
    } else {
      this.cancelLoop();
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    if (next.releasable) {
      if (!this.releaseTimer && !this.released) {
        this.releaseTimer = setTimeout(() => {
          this.releaseTimer = undefined;
          if (this.decision?.releasable && !this.released) {
            this.released = true;
            this.hooks.release?.();
          }
        }, RELEASE_AFTER_MS);
      }
    } else {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    if (this.released && next.run) {
      this.released = false;
      this.hooks.restore?.();
    }

    this.hooks.changed(next, previous);
  }

  private scheduleLoop() {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private cancelLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly loop = (ms: number) => {
    this.raf = 0;
    const decision = this.decision;
    if (!decision?.run) return;
    this.measureDisplay(ms);
    const wanted = 1000 / Math.max(1, decision.fps);
    const since = ms - this.lastDraw;
    // A little slack, so a 30 fps ceiling on a 60 Hz display draws every second refresh rather than every third.
    if (this.lastDraw === 0 || since >= wanted - Math.min(3, wanted / 4)) {
      const interval = this.lastDraw === 0 ? 0 : since;
      this.lastDraw = ms;
      const started = performance.now();
      try {
        this.hooks.frame(ms / 1000);
      } catch (error) {
        console.error("frame failed", error);
      }
      const spent = performance.now() - started;
      this.frames++;
      this.cost = this.cost ? this.cost * 0.9 + spent * 0.1 : spent;
      if (interval) this.interval = this.interval ? this.interval * 0.9 + interval * 0.1 : interval;
    }
    this.scheduleLoop();
  };

  /** Median of the raw animation-frame spacing over the first moments: the display's refresh rate. */
  private measureDisplay(ms: number) {
    if (this.displayHz !== undefined) return;
    if (this.lastRaf) this.rafDeltas.push(ms - this.lastRaf);
    this.lastRaf = ms;
    if (this.rafDeltas.length < 45) return;
    const sorted = [...this.rafDeltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.rafDeltas = [];
    // Only trust a plausible figure; a throttled or software-rendered page reports nonsense.
    this.displayHz = median >= 5 && median <= 34 ? Math.round(1000 / median) : 60;
    queueMicrotask(() => this.refresh());
  }
}
