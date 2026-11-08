import assert from "node:assert/strict";
import test from "node:test";
import {
  BAND,
  BandPath,
  TRACK,
  centreAt,
  holeCentre,
  lapFlip,
  newPlate,
  plateAt,
  staggered,
  trackPlateAt,
  trackSlot,
  turnPlate,
  unrollOrder,
  velocityAt,
  type PlateFrame,
  type Vec3,
} from "../../src/fin-band";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function assertFrame(frame: PlateFrame, eps = 1e-9) {
  near(dot(frame.x, frame.x), 1, eps);
  near(dot(frame.y, frame.y), 1, eps);
  near(dot(frame.z, frame.z), 1, eps);
  near(dot(frame.x, frame.y), 0, eps);
  near(dot(frame.y, frame.z), 0, eps);
  near(dot(frame.x, frame.z), 0, eps);
  const handed = cross(frame.x, frame.y);
  near(dot(handed, frame.z), 1, eps);
}

const path = new BandPath();

test("the centre line is a closed figure eight: tips at ±radius, a crossing at the middle, strands apart in depth", () => {
  const start = centreAt(0);
  const end = centreAt(Math.PI * 2);
  assert.ok(dist(start, end) < 1e-9);
  near(centreAt(0)[0], BAND.radius);
  near(centreAt(Math.PI)[0], -BAND.radius);
  // t = π/2 and 3π/2 are the two passes through the crossing: same x, y, opposite z.
  const a = centreAt(Math.PI / 2);
  const b = centreAt((3 * Math.PI) / 2);
  near(a[0], 0, 1e-9);
  near(a[1], 0, 1e-9);
  near(b[0], 0, 1e-9);
  near(a[2], -b[2]);
  assert.ok(Math.abs(a[2] - b[2]) > 2 * BAND.plate.width * 0.9, "the two strands must clear each other at the crossing");
});

test("the analytic velocity matches a finite difference", () => {
  for (const t of [0.1, 0.9, 1.7, 2.6, 3.3, 4.4, 5.5]) {
    const h = 1e-5;
    const a = centreAt(t - h);
    const b = centreAt(t + h);
    const v = velocityAt(t);
    for (let axis = 0; axis < 3; axis++) near(v[axis], (b[axis] - a[axis]) / (2 * h), 1e-4);
  }
});

test("lap fractions are spaced evenly in space: plates are not bunched up at the tips", () => {
  const count = 120;
  const points: Vec3[] = [];
  for (let i = 0; i <= count; i++) points.push(centreAt(path.param(i / count)));
  const steps = points.slice(1).map((p, i) => dist(p, points[i]));
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  for (const step of steps) assert.ok(Math.abs(step - mean) / mean < 0.03, `step ${step} vs mean ${mean}`);
  near(path.length, mean * count, mean * 0.5);
});

test("every plate frame is orthonormal and right-handed, whatever the lap fraction and clock", () => {
  const frame = newPlate();
  for (let i = 0; i < 240; i++) {
    plateAt(path, i / 240 + 0.0013, i * 0.37, frame);
    assertFrame(frame);
  }
});

test("the band closes without a seam: the plate at the end of the lap is the plate at its start, up to a half turn in its own plane", () => {
  const early = newPlate();
  const late = newPlate();
  for (const eps of [1e-9, 1e-6]) {
    plateAt(path, eps, 0, early);
    plateAt(path, 1 - eps, 0, late);
    assert.ok(dist(early.p, late.p) < 1e-3);
    // Same thin axis (the way the big faces point), and the wide axes are opposite: a plate has no preferred "up".
    for (let axis = 0; axis < 3; axis++) {
      near(early.z[axis], late.z[axis], 1e-3);
      near(early.x[axis], -late.x[axis], 1e-3);
      near(early.y[axis], -late.y[axis], 1e-3);
    }
  }
});

test("consecutive plates differ by a small step: no jumps along the band", () => {
  const a = newPlate();
  const b = newPlate();
  const n = 720;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    plateAt(path, i / n, 0, a);
    plateAt(path, (i + 1) / n, 0, b);
    // The wide axis may flip sign across the seam; compare the plate normals only (they never flip).
    worst = Math.max(worst, 1 - dot(a.z, b.z));
    assert.ok(dist(a.p, b.p) < (path.length / n) * 1.2);
  }
  assert.ok(worst < 0.01, `plate normals turn by at most ${Math.acos(1 - worst)} rad per step`);
});

test("the twist is a Möbius twist: the roll turns by an odd number of half turns over a lap", () => {
  const turns = BAND.twist * 2;
  assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9);
  assert.equal(Math.round(turns) % 2, 1);
});

test("an archive turned over by lapFlip comes back to the focus upright: the flip is 0 near the focus and π at the seam", () => {
  near(lapFlip(BAND.focus), 0);
  near(lapFlip(BAND.seam + 0.999999), Math.PI, 1e-3);
  near(lapFlip(BAND.seam), 0);
  // Within the lap it changes smoothly (the step back to 0 at the seam is the one that cancels the plate's own flip).
  let previous = lapFlip(0);
  for (let i = 1; i < 400; i++) {
    const value = lapFlip(i / 400);
    assert.ok(Math.abs(value - previous) < 0.2, "flip changes smoothly");
    previous = value;
  }
});

test("a card is in the same pose just before and just after the seam: the plate roll and the flip cancel", () => {
  const before = newPlate();
  const after = newPlate();
  for (const eps of [1e-7, 1e-5]) {
    turnPlate(plateAt(path, 1 - eps, 0, before), lapFlip(1 - eps));
    turnPlate(plateAt(path, eps, 0, after), lapFlip(eps));
    assert.ok(dist(before.p, after.p) < 1e-2);
    for (let axis = 0; axis < 3; axis++) {
      near(before.x[axis], after.x[axis], 2e-2);
      near(before.y[axis], after.y[axis], 2e-2);
      near(before.z[axis], after.z[axis], 2e-2);
    }
  }
});

test("turnPlate rotates the wide and tall axes in the plate's plane and keeps the thin axis", () => {
  const frame = plateAt(path, 0.31, 0);
  const z = [...frame.z];
  const x = [...frame.x];
  turnPlate(frame, Math.PI);
  assertFrame(frame);
  for (let axis = 0; axis < 3; axis++) {
    near(frame.z[axis], z[axis]);
    near(frame.x[axis], -x[axis]);
  }
});

test("the track lies along the row, flat, under the cards: plates are orthonormal and ordered along it", () => {
  const frame = newPlate();
  let previous = -Infinity;
  for (let i = 0; i <= 50; i++) {
    const u = i / 50;
    trackPlateAt(u, frame);
    assertFrame(frame);
    near(frame.p[1], -TRACK.drop);
    assert.ok(frame.p[0] > previous, "x increases along the track");
    previous = frame.p[0];
  }
  near(trackSlot(0), TRACK.from);
  near(trackSlot(1), TRACK.to);
});

test("unrollOrder is 0 at the focus and 1 opposite it; staggered runs from 0 to 1 for every plate", () => {
  near(unrollOrder(BAND.focus), 0);
  near(unrollOrder(BAND.focus + 0.5), 1);
  near(unrollOrder(BAND.focus + 0.25), 0.5);
  near(unrollOrder(BAND.focus - 0.25), 0.5);
  for (const order of [0, 0.3, 0.7, 1]) {
    near(staggered(0, order), 0);
    near(staggered(1, order), 1);
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      const value = staggered(i / 20, order);
      assert.ok(value >= previous - 1e-12);
      previous = value;
    }
  }
  // The plates at the focus move before the ones far from it.
  assert.ok(staggered(0.4, 0) > staggered(0.4, 1));
});

test("the opening of the left loop is inside the left loop", () => {
  const hole = holeCentre();
  assert.ok(hole[0] < 0 && Math.abs(hole[0]) < BAND.radius);
  // Every centre-line point with x < 0 is farther from the opening's middle than the plates are wide: it is clear of the opening.
  let nearest = Infinity;
  for (let i = 0; i < 360; i++) {
    const p = centreAt((Math.PI * 2 * i) / 360);
    nearest = Math.min(nearest, Math.hypot(p[0] - hole[0], p[1] - hole[1]));
  }
  assert.ok(nearest > 3.3, `the nearest the band comes to the opening's middle is ${nearest}`);
});
