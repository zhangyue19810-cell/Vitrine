import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDLE_DEEP_MS, IDLE_EASE_MS, QualityGovernor, baseFps, decide, initialTier, sameDecision, type PerfInputs } from "../../src/app/perf-policy";

const base: PerfInputs = {
  visible: true,
  focused: true,
  gameRunning: false,
  launching: false,
  covered: false,
  idleMs: 0,
  fps: "auto",
  pauseWhenGameRuns: true,
  whenUnfocused: "pause",
  reducedMotion: false,
};
const make = (patch: Partial<PerfInputs>): PerfInputs => ({ ...base, ...patch });

describe("render policy", () => {
  it("draws at full rate while the window is focused and in use", () => {
    const d = decide(base);
    assert.deepEqual({ run: d.run, fps: d.fps, level: d.level, reason: d.reason }, { run: true, fps: 60, level: "active", reason: "active" });
  });

  it("stops completely when the window cannot be seen, and tells the core it is hidden", () => {
    const d = decide(make({ visible: false, focused: false }));
    assert.equal(d.run, false);
    assert.equal(d.level, "hidden");
    assert.equal(d.reason, "hidden");
  });

  it("stops while a launch is being prepared, even though the window is focused", () => {
    const d = decide(make({ launching: true }));
    assert.equal(d.run, false);
    assert.equal(d.reason, "launch");
    assert.equal(d.level, "active", "the launch screen itself still needs live progress");
  });

  it("keeps drawing during a launch when the player turned the pause off", () => {
    assert.equal(decide(make({ launching: true, pauseWhenGameRuns: false })).run, true);
  });

  it("stops when the game is running and the launcher is not focused (the game needs the GPU)", () => {
    const d = decide(make({ gameRunning: true, focused: false, whenUnfocused: "full" }));
    assert.equal(d.run, false);
    assert.equal(d.reason, "game-blurred");
    assert.equal(d.level, "background");
    assert.equal(d.releasable, true);
  });

  it("resumes when the player focuses the launcher again, economically while the game is still running", () => {
    const d = decide(make({ gameRunning: true, focused: true }));
    assert.equal(d.run, true);
    assert.equal(d.fps, 30);
    assert.equal(d.reason, "economy");
    assert.equal(d.level, "active");
  });

  it("resumes at full rate once the game has exited", () => {
    const d = decide(make({ gameRunning: false, focused: true }));
    assert.equal(d.run, true);
    assert.equal(d.fps, 60);
  });

  it("follows the 'when unfocused' choice when no game runs", () => {
    assert.equal(decide(make({ focused: false, whenUnfocused: "pause" })).run, false);
    const slow = decide(make({ focused: false, whenUnfocused: "throttle" }));
    assert.deepEqual([slow.run, slow.fps, slow.level], [true, 10, "background"]);
    const full = decide(make({ focused: false, whenUnfocused: "full" }));
    assert.deepEqual([full.run, full.fps], [true, 60]);
  });

  it("does not release GPU memory merely because the window lost focus without a game", () => {
    assert.equal(decide(make({ focused: false })).releasable, false);
  });

  it("releases GPU memory when a minimised window has a running game behind it", () => {
    assert.equal(decide(make({ visible: false, focused: false, gameRunning: true })).releasable, true);
    assert.equal(decide(make({ visible: false, focused: false, gameRunning: false })).releasable, false);
  });

  it("eases the frame rate down when nothing is touched, and back up on input", () => {
    assert.equal(decide(make({ idleMs: IDLE_EASE_MS - 1 })).fps, 60);
    const idle = decide(make({ idleMs: IDLE_EASE_MS }));
    assert.deepEqual([idle.fps, idle.reason], [30, "idle"]);
    const deep = decide(make({ idleMs: IDLE_DEEP_MS }));
    assert.deepEqual([deep.fps, deep.reason], [15, "idle-deep"]);
    assert.equal(decide(make({ idleMs: 0 })).fps, 60);
  });

  it("never exceeds the configured ceiling, and caps reduced motion at 30", () => {
    assert.equal(decide(make({ fps: 30 })).fps, 30);
    assert.equal(decide(make({ fps: 30, idleMs: IDLE_DEEP_MS })).fps, 15);
    assert.equal(decide(make({ fps: 120 })).fps, 120);
    assert.equal(decide(make({ reducedMotion: true })).fps, 30);
    assert.equal(decide(make({ fps: 30, focused: false, whenUnfocused: "throttle" })).fps, 10);
  });

  it("stops when something opaque covers the scene", () => {
    const d = decide(make({ covered: true }));
    assert.deepEqual([d.run, d.reason], [false, "covered"]);
  });

  it("treats 'auto' as the display's rate up to 60", () => {
    assert.equal(baseFps("auto"), 60);
    assert.equal(baseFps("auto", 144), 60);
    assert.equal(baseFps("auto", 75), 75);
    assert.equal(baseFps("auto", 50), 50);
    assert.equal(baseFps("auto", 20), 30);
    assert.equal(baseFps(120, 60), 120);
  });

  it("recognises identical decisions so the scheduler does not churn", () => {
    const a = decide(base);
    assert.equal(sameDecision(a, decide(base)), true);
    assert.equal(sameDecision(a, decide(make({ focused: false }))), false);
    assert.equal(sameDecision(undefined, a), false);
  });
});

describe("quality governor", () => {
  const feed = (governor: QualityGovernor, ms: number, count = 90) => {
    for (let i = 0; i < count; i++) governor.push(ms);
  };

  it("keeps the tier while frames are fast", () => {
    const g = new QualityGovernor("medium");
    feed(g, 16);
    assert.equal(g.evaluate(100_000, 60), undefined);
    assert.equal(g.tier, "medium");
  });

  it("waits for a full window of samples", () => {
    const g = new QualityGovernor("medium");
    feed(g, 80, 30);
    assert.equal(g.evaluate(100_000, 60), undefined);
  });

  it("steps down when the median frame is slow, then waits before judging again", () => {
    const g = new QualityGovernor("high");
    feed(g, 50);
    assert.equal(g.evaluate(100_000, 60), "medium");
    feed(g, 50);
    assert.equal(g.evaluate(105_000, 60), undefined, "cooldown");
    assert.equal(g.evaluate(121_000, 60), "low");
  });

  it("ignores a few hitches", () => {
    const g = new QualityGovernor("medium");
    feed(g, 16, 80);
    feed(g, 200, 10);
    assert.equal(g.evaluate(100_000, 60), undefined);
  });

  it("is lenient at a 30 fps ceiling and never goes below its floor", () => {
    const g = new QualityGovernor("medium", { floor: "low" });
    feed(g, 40);
    assert.equal(g.evaluate(100_000, 30), undefined, "40 ms is fine for 30 fps");
    feed(g, 80);
    assert.equal(g.evaluate(100_000, 30), "low");
    feed(g, 200);
    assert.equal(g.evaluate(200_000, 30), undefined, "floor reached");
  });

  it("starts at the lowest tier on a software rasteriser, and honours the setting elsewhere", () => {
    assert.equal(initialTier("auto", "Google SwiftShader"), "minimal");
    assert.equal(initialTier("high", "llvmpipe (LLVM 15.0.7, 256 bits)"), "minimal");
    assert.equal(initialTier("auto", "NVIDIA GeForce RTX 5070"), "medium");
    assert.equal(initialTier("high", "NVIDIA GeForce RTX 5070"), "high");
    assert.equal(initialTier("low", "AMD Radeon"), "low");
  });
});
