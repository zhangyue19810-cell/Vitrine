import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW } from "../../src/space/disk";
import { DiskView, VIEW } from "../../src/space/view";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** Let `seconds` of frames go by at 60 per second. */
function run(view: DiskView, seconds: number, pointer: { x: number; y: number } | null = null, calm = false) {
  for (let t = 0; t < seconds; t += 1 / 60) view.update(1 / 60, pointer, calm);
}

test("the view begins on the composed picture and says it has not been changed", () => {
  const view = new DiskView();
  assert.deepEqual({ ...view.goal }, { ...DEFAULT_VIEW });
  assert.deepEqual({ ...view.now }, { ...DEFAULT_VIEW });
  assert.equal(view.changed, false);
  assert.equal(view.moving, false);
  run(view, 1);
  assert.equal(view.moving, false, "nothing touched it, so nothing moves in the first seconds");
});

test("dragging turns the disk about its axis (roll) and tips it (elevation), by the amount of the drag, and stops at the limits", () => {
  const view = new DiskView();
  view.grab();
  view.drag(0.1, 0.1);
  near(view.goal.roll, DEFAULT_VIEW.roll + 0.1 * VIEW.orbit.roll);
  near(view.goal.elevation, DEFAULT_VIEW.elevation + 0.1 * VIEW.orbit.elevation);
  assert.equal(view.changed, true);
  view.drag(5, 5);
  assert.equal(view.goal.roll, VIEW.roll.max);
  assert.equal(view.goal.elevation, VIEW.elevation.max);
  view.drag(-50, -50);
  assert.equal(view.goal.roll, VIEW.roll.min);
  assert.equal(view.goal.elevation, VIEW.elevation.min);
});

test("the wheel and the pinch change the size by a factor, within the limits", () => {
  const view = new DiskView();
  view.zoomBy(1);
  near(view.goal.zoom, VIEW.notch);
  view.zoomBy(-1);
  near(view.goal.zoom, 1);
  view.scaleBy(1.5);
  near(view.goal.zoom, 1.5);
  view.zoomBy(100);
  assert.equal(view.goal.zoom, VIEW.zoom.max);
  view.scaleBy(0.0001);
  assert.equal(view.goal.zoom, VIEW.zoom.min);
  assert.equal(view.changed, true);
});

test("the picture follows what the hand has set and settles on it (no overshoot to speak of), then stops moving", () => {
  const view = new DiskView();
  view.grab();
  view.drag(0.12, -0.08);
  view.zoomBy(2);
  view.release();
  const goal = { ...view.goal };
  let peak = -Infinity;
  for (let t = 0; t < 3; t += 1 / 60) {
    view.update(1 / 60);
    peak = Math.max(peak, view.now.roll);
  }
  near(view.now.roll, goal.roll, 2e-3);
  near(view.now.elevation, goal.elevation, 2e-3);
  near(view.now.zoom, goal.zoom, 2e-3);
  assert.ok(peak < goal.roll + 0.02, "a critically damped spring does not overshoot");
  assert.equal(view.moving, false);
});

test("a flick keeps going after the hand lets go and slows down on its own, and it stops at a limit", () => {
  const view = new DiskView();
  view.grab();
  view.release(1, 0);
  const start = view.goal.roll;
  run(view, 4);
  // The distance of a flick is its speed over the friction: 1 picture height per second is `orbit.roll` radians per second.
  near(view.goal.roll - start, VIEW.orbit.roll / VIEW.friction, 0.03);
  const rest = view.goal.roll;
  run(view, 2);
  near(view.goal.roll, rest, 1e-3);
  // Hard against the limit it stops there.
  view.release(3, 0);
  run(view, 3);
  assert.equal(view.goal.roll, VIEW.roll.max);
  // Taking hold of the picture again stops a flick at once.
  const other = new DiskView();
  other.release(1, 0);
  run(other, 0.2);
  const during = other.goal.roll;
  other.grab();
  run(other, 1);
  assert.equal(other.goal.roll, during);
});

test("left alone for a while the picture breathes a little by itself, and not at all when motion is reduced", () => {
  const view = new DiskView();
  run(view, VIEW.rest * 1.5);
  let widest = 0;
  for (let t = 0; t < VIEW.breath.period; t += 1 / 20) {
    view.update(1 / 20);
    widest = Math.max(widest, Math.abs(view.now.roll - view.goal.roll));
  }
  assert.ok(widest > 0.004, `it breathes (${widest})`);
  assert.ok(widest < VIEW.breath.roll + 0.01, `but only a little (${widest})`);
  assert.equal(view.moving, true, "while it breathes the scene must keep drawing");

  const calm = new DiskView();
  let still = 0;
  for (let t = 0; t < VIEW.rest * 3; t += 1 / 20) {
    calm.update(1 / 20, null, true);
    still = Math.max(still, Math.abs(calm.now.roll - calm.goal.roll), Math.abs(calm.now.elevation - calm.goal.elevation));
  }
  assert.ok(still < 1e-3, `reduced motion leaves it still (${still})`);
});

test("the picture leans a little towards the pointer, and not while a hand holds it", () => {
  // (Each in a view of its own, and within the first seconds: left alone for longer, the picture breathes on top of the lean.)
  const right = new DiskView();
  run(right, 2, { x: 1, y: 0 });
  near(right.now.roll - right.goal.roll, VIEW.lean.roll, 0.004);
  const left = new DiskView();
  run(left, 2, { x: -1, y: 0 });
  near(left.now.roll - left.goal.roll, -VIEW.lean.roll, 0.004);
  const up = new DiskView();
  run(up, 2, { x: 0, y: 1 });
  near(up.now.elevation - up.goal.elevation, -VIEW.lean.elevation, 0.004);
  // Held, there is no lean (the hand is in charge).
  const view = new DiskView();
  view.grab();
  run(view, 2, { x: 1, y: 1 });
  near(view.now.roll, view.goal.roll, 2e-3);
  // And with reduced motion either.
  const calm = new DiskView();
  run(calm, 2, { x: 1, y: 1 }, true);
  near(calm.now.roll, calm.goal.roll, 2e-3);
});

test("a view that must land at once does (a reduced-motion player, or the first frame), and reset brings the composed picture back", () => {
  const view = new DiskView();
  view.grab();
  view.drag(0.2, 0.2);
  view.zoomBy(3);
  view.release();
  view.update(1 / 60, null, false, true);
  view.update(1 / 60, null, false, true);
  view.update(1 / 60, null, false, true);
  assert.ok(Math.abs(view.now.roll - view.goal.roll) < Math.abs(0.2 * VIEW.orbit.roll) * 0.2, "it is most of the way there in three frames");
  view.reset();
  assert.deepEqual({ ...view.goal }, { ...DEFAULT_VIEW });
  assert.equal(view.changed, false);
  run(view, 3);
  near(view.now.roll, DEFAULT_VIEW.roll, 2e-3);
  near(view.now.elevation, DEFAULT_VIEW.elevation, 2e-3);
  near(view.now.zoom, DEFAULT_VIEW.zoom, 2e-3);
});

test("a long frame (the window was behind another one) does not throw the picture: one step is never longer than a twentieth of a second", () => {
  const long = new DiskView();
  long.grab();
  long.drag(0.15, 0);
  long.update(10);
  const short = new DiskView();
  short.grab();
  short.drag(0.15, 0);
  short.update(0.05);
  near(long.now.roll, short.now.roll, 1e-12);
  assert.ok(Number.isFinite(long.now.roll));
});

test("the drawn view never goes past a limit, even while the spring is still catching up", () => {
  const view = new DiskView();
  view.grab();
  view.drag(50, 50);
  view.zoomBy(100);
  for (let t = 0; t < 3; t += 1 / 60) {
    const now = view.update(1 / 60);
    assert.ok(now.roll <= VIEW.roll.max + 0.1 + 1e-9);
    assert.ok(now.elevation <= VIEW.elevation.max + 0.08 + 1e-9);
    assert.ok(now.zoom <= VIEW.zoom.max * 1.05 + 1e-9);
  }
  view.drag(-100, -100);
  view.scaleBy(0.0001);
  for (let t = 0; t < 3; t += 1 / 60) {
    const now = view.update(1 / 60);
    assert.ok(now.roll >= VIEW.roll.min - 0.1 - 1e-9);
    assert.ok(now.elevation >= VIEW.elevation.min * 0.8 - 1e-9);
    assert.ok(now.zoom >= VIEW.zoom.min * 0.9 - 1e-9);
  }
});
