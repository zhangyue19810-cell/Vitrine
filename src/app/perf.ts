import { tryRpc } from "./api";
import { QualityGovernor, initialTier, type PerfDecision, type UiLevel } from "./perf-policy";
import { RenderScheduler } from "./scheduler";
import type { SceneHost } from "./scene-host";
import type { Settings } from "./types";

/**
 * Ties the render scheduler, the quality governor and the core's "how busy is the interface" level to the rest of the
 * app. The decisions themselves are in perf-policy.ts; this class only supplies the live inputs and carries them out:
 *
 *  - launch preparing / sheet open / window hidden or unfocused behind a game → the 3D loop is not scheduled at all;
 *  - the window is focused again → the loop resumes, and a scene that was given back to the GPU is rebuilt;
 *  - frame times are watched while the scene runs at its ceiling, and the quality only ever steps down when the
 *    machine cannot keep up (never in a manual quality setting);
 *  - the core is told how closely the interface is watching, so it can thin out progress and log traffic.
 */

export interface PerfApp {
  readonly host: SceneHost;
  settings(): Settings | undefined;
  gameRunning(): boolean;
  launching(): boolean;
  /** Something opaque covers the 3D scene. */
  covered(): boolean;
  reducedMotion(): boolean;
  /** Draw one frame of the scene and what follows it (palette, inspection overlay, detail shade). */
  draw(time: number): void;
  /** The scene was handed back to the GPU. */
  released(): void;
  /** The scene is needed again; resolves when it has been rebuilt. */
  restore(): Promise<void>;
}

/** After a scene is (re)built the first seconds are spent on texture uploads and the drop-in: do not judge them. */
const GRACE_MS = 4000;

export class Perf {
  readonly scheduler: RenderScheduler;
  private governor: QualityGovernor;
  private qualitySetting?: string;
  private lastFrame = 0;
  private graceUntil = 0;
  private level?: UiLevel;
  private levelTimer?: ReturnType<typeof setTimeout>;
  /** Tiers the governor stepped down to during this run, for the debug hook and the footer. */
  readonly steps: { at: number; tier: string }[] = [];

  constructor(
    private readonly app: PerfApp,
    private readonly rendererName: string,
  ) {
    this.governor = new QualityGovernor(initialTier("auto", rendererName));
    this.scheduler = new RenderScheduler({
      frame: (time) => this.frame(time),
      inputs: () => {
        const ui = app.settings()?.ui;
        return {
          gameRunning: app.gameRunning(),
          launching: app.launching(),
          covered: app.covered(),
          fps: ui?.fps ?? "auto",
          pauseWhenGameRuns: ui?.pauseWhenGameRuns ?? true,
          whenUnfocused: ui?.whenUnfocused ?? "pause",
          reducedMotion: app.reducedMotion(),
        };
      },
      changed: (next, previous) => this.changed(next, previous),
      release: () => {
        if (app.settings()?.ui.releaseGpuWhenGameRuns === false) return;
        app.host.release();
        app.released();
      },
      restore: () => {
        void app.restore().then(() => this.sceneReady());
      },
    });
  }

  start() {
    this.scheduler.start();
  }

  refresh() {
    this.scheduler.refresh();
  }

  get running() {
    return this.scheduler.running;
  }

  /** Apply the quality setting. "auto" starts at the tier the GPU suggests and may step down; the others are fixed. */
  applyQuality() {
    const setting = this.app.settings()?.ui.quality ?? "auto";
    if (setting === this.qualitySetting) return;
    this.qualitySetting = setting;
    const tier = initialTier(setting, this.rendererName);
    this.governor = new QualityGovernor(tier);
    this.app.host.setTier(tier);
  }

  /** The scene was (re)built: let it settle before frame times count. */
  sceneReady() {
    this.graceUntil = performance.now() + GRACE_MS;
    this.lastFrame = 0;
    this.governor.reset();
    this.app.host.setTier(this.governor.tier);
  }

  private frame(time: number) {
    const now = performance.now();
    this.app.draw(time);
    const decision = this.scheduler.current;
    if (this.lastFrame && this.qualitySetting === "auto" && decision?.run && decision.reason === "active" && now > this.graceUntil && this.app.host.ready) {
      this.governor.push(now - this.lastFrame);
      const next = this.governor.evaluate(now, decision.fps);
      if (next) {
        this.app.host.setTier(next);
        this.steps.push({ at: Math.round(now), tier: next });
        console.info(`[vitrine] 画面较卡，3D 画质自动降为“${next}”`);
      }
    }
    this.lastFrame = now;
  }

  private changed(next: PerfDecision, previous: PerfDecision | undefined) {
    // The gap while paused must not look like one slow frame.
    this.lastFrame = 0;
    if (next.run && !previous?.run) this.governor.reset();
    this.pushLevel(next.level);
  }

  /** Tell the core how closely the interface is watching (it thins out progress events accordingly). */
  pushLevel(level: UiLevel, force = false) {
    if (level === this.level && !force) return;
    this.level = level;
    clearTimeout(this.levelTimer);
    this.levelTimer = setTimeout(() => void tryRpc("ui.setLevel", { level }), 100);
  }

  /** The connection to the core was re-established: it forgot our level. */
  resend() {
    if (this.level) this.pushLevel(this.level, true);
  }

  stop() {
    this.scheduler.stop();
    clearTimeout(this.levelTimer);
  }
}
