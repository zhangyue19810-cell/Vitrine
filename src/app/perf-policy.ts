/**
 * When should the launcher draw, and how hard? Everything here is a pure function of the inputs, so the rules can be
 * tested without a browser (core/test/perf-policy.test.ts) and the scheduler stays a thin shell around them.
 *
 * The rules, in the order they are applied:
 *
 *  1. The window cannot be seen (minimised, on another desktop)      → stop drawing; tell the core "hidden".
 *  2. A launch is being prepared and the launch screen covers the 3D scene → stop drawing.
 *  3. The window is visible but not focused:
 *       a game is running                       → stop drawing (the game needs the GPU more than the launcher does)
 *       otherwise per the player's choice       → stop / draw at 10 fps / carry on
 *  4. The window is focused:
 *       a game is running                       → draw again, but economically (≤ 30 fps): the player came back to
 *                                                  the launcher, yet the game is still sharing the GPU
 *       otherwise                               → full rate, easing down when nothing has been touched for a while
 *
 * "Stop drawing" means the animation frame loop is not even scheduled: no scene update, no rendering, no timers.
 */

export type UiLevel = "active" | "background" | "hidden";
export type WhenUnfocused = "pause" | "throttle" | "full";
export type FpsSetting = "auto" | 30 | 60 | 120;

export interface PerfInputs {
  /** The page is visible (not minimised, not hidden behind other desktops). */
  visible: boolean;
  /** The launcher window has the input focus. */
  focused: boolean;
  /** A game process the launcher started is alive (starting, window open or running). */
  gameRunning: boolean;
  /** A launch task is preparing the game right now. */
  launching: boolean;
  /** Something opaque covers the 3D scene, so drawing it would be wasted work. */
  covered: boolean;
  /** Milliseconds since the player last touched the window. */
  idleMs: number;
  fps: FpsSetting;
  pauseWhenGameRuns: boolean;
  whenUnfocused: WhenUnfocused;
  reducedMotion: boolean;
  /** Refresh rate of the display, when known (used for "auto"). */
  displayHz?: number;
}

export type PerfReason = "hidden" | "launch" | "covered" | "game-blurred" | "blurred" | "economy" | "idle-deep" | "idle" | "active";

export interface PerfDecision {
  run: boolean;
  /** Frame-rate ceiling while running. */
  fps: number;
  /** What to tell the core, so it can cut progress / log traffic accordingly. */
  level: UiLevel;
  reason: PerfReason;
  /** GPU resources may be released if this stays true for a while (the game wants the VRAM). */
  releasable: boolean;
}

/** Delays (ms) of the idle tiers. */
export const IDLE_EASE_MS = 10_000;
export const IDLE_DEEP_MS = 90_000;
/** How long the 3D scene must have been paused because of a running game before its GPU memory is given back. */
export const RELEASE_AFTER_MS = 15_000;

export function baseFps(setting: FpsSetting, displayHz?: number): number {
  if (setting !== "auto") return setting;
  // Auto never goes beyond 60: the scene is a slow ambient animation, not a game.
  const hz = displayHz && Number.isFinite(displayHz) ? displayHz : 60;
  return hz <= 75 ? Math.max(30, Math.round(hz)) : 60;
}

export function decide(input: PerfInputs): PerfDecision {
  const cap = baseFps(input.fps, input.displayHz);
  const reduced = input.reducedMotion;
  const ceiling = reduced ? Math.min(cap, 30) : cap;

  if (!input.visible) return { run: false, fps: 0, level: "hidden", reason: "hidden", releasable: input.gameRunning };

  const level: UiLevel = input.focused ? "active" : "background";

  if (input.launching && input.pauseWhenGameRuns) return { run: false, fps: 0, level, reason: "launch", releasable: false };
  if (input.covered) return { run: false, fps: 0, level, reason: "covered", releasable: false };

  if (!input.focused) {
    if (input.gameRunning && input.pauseWhenGameRuns) return { run: false, fps: 0, level, reason: "game-blurred", releasable: true };
    switch (input.whenUnfocused) {
      case "pause":
        return { run: false, fps: 0, level, reason: "blurred", releasable: false };
      case "throttle":
        return { run: true, fps: Math.min(10, ceiling), level, reason: "blurred", releasable: false };
      default:
        return { run: true, fps: ceiling, level, reason: "active", releasable: false };
    }
  }

  if (input.gameRunning && input.pauseWhenGameRuns) return { run: true, fps: Math.min(30, ceiling), level, reason: "economy", releasable: false };
  if (input.idleMs >= IDLE_DEEP_MS) return { run: true, fps: Math.min(15, ceiling), level, reason: "idle-deep", releasable: false };
  if (input.idleMs >= IDLE_EASE_MS) return { run: true, fps: Math.min(30, ceiling), level, reason: "idle", releasable: false };
  return { run: true, fps: ceiling, level, reason: "active", releasable: false };
}

export function sameDecision(a: PerfDecision | undefined, b: PerfDecision): boolean {
  return !!a && a.run === b.run && a.fps === b.fps && a.level === b.level && a.reason === b.reason && a.releasable === b.releasable;
}

// ---------------------------------------------------------------------------------------------- quality governor

export type QualityTier = "high" | "medium" | "low" | "minimal";
export const QUALITY_ORDER: QualityTier[] = ["high", "medium", "low", "minimal"];

/**
 * Picks the 3D quality tier for "auto" and walks it down when the machine cannot keep up.
 * It only ever steps down (a flapping quality setting is worse than a slightly low one), at most once every 20 s,
 * and judges the median of recent frame times so a single hitch does not count.
 */
export class QualityGovernor {
  private samples: number[] = [];
  private lastStep = -Infinity;

  constructor(
    public tier: QualityTier,
    private readonly options: { window?: number; slowMs?: number; cooldownMs?: number; floor?: QualityTier } = {},
  ) {}

  /** Record the time between two drawn frames (ms) taken while the scene was running at its ceiling. */
  push(frameMs: number) {
    const window = this.options.window ?? 90;
    this.samples.push(frameMs);
    if (this.samples.length > window) this.samples.shift();
  }

  reset() {
    this.samples = [];
  }

  /** The tier to switch to, or undefined to stay. */
  evaluate(now: number, targetFps: number): QualityTier | undefined {
    const window = this.options.window ?? 90;
    if (this.samples.length < window) return undefined;
    if (now - this.lastStep < (this.options.cooldownMs ?? 20_000)) return undefined;
    const floor = QUALITY_ORDER.indexOf(this.options.floor ?? "minimal");
    const index = QUALITY_ORDER.indexOf(this.tier);
    if (index >= floor) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // "Slow" = clearly below what the frame-rate ceiling asks for (30 fps ceilings tolerate 45 ms frames, 60 fps ones 28 ms).
    const slow = this.options.slowMs ?? (targetFps >= 50 ? 28 : 45);
    if (median <= slow) return undefined;
    this.tier = QUALITY_ORDER[index + 1];
    this.lastStep = now;
    this.samples = [];
    return this.tier;
  }
}

/** A software rasteriser (no GPU) cannot run the glass materials at all: start at the lowest tier. */
export function initialTier(setting: "auto" | "high" | "medium" | "low", rendererName: string): QualityTier {
  if (/swiftshader|llvmpipe|software|basic render|softpipe/i.test(rendererName)) return "minimal";
  if (setting === "auto") return "medium";
  return setting;
}
