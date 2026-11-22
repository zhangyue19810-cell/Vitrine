import assert from "node:assert/strict";
import test from "node:test";
import { newPlate, type PlateFrame, type Vec3 } from "../../src/fin-band";
import { COSMOS, cosmosPlate, eyeOf, hash, keepClear, newPlaced, type KeepOut } from "../../src/space/cosmos";
import { HALO, haloAngle, haloFrame, haloPlate, haloSlot, placeOf, ringOf } from "../../src/space/halo";
import { RIPPLE, RippleSet, newSample, rippleWave } from "../../src/space/ripples";
import { project, ringCamera, rowCamera } from "../../src/stage-layout";
import { DECK_TILT, deckLayout } from "../../src/deck/model";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function assertFrame(frame: PlateFrame, eps = 1e-9) {
  near(dot(frame.x, frame.x), 1, eps);
  near(dot(frame.y, frame.y), 1, eps);
  near(dot(frame.z, frame.z), 1, eps);
  near(dot(frame.x, frame.y), 0, eps);
  near(dot(frame.y, frame.z), 0, eps);
  near(dot(frame.x, frame.z), 0, eps);
  near(dot(cross(frame.x, frame.y), frame.z), 1, eps);
}

// ───────────────────────────────────────────── ripples ─────────────────────────────────────────────

test("a ripple's crest travels outwards at its speed and dies away", () => {
  const age = 0.5;
  const front = RIPPLE.speed * age;
  // The tallest crest of the first ring is at the front.
  assert.ok(rippleWave(front, age) > 0.3, "crest at the front");
  // A little later the ring is a whole band away from where it was dropped: calm inside it, calm far outside it.
  assert.ok(Math.abs(rippleWave(RIPPLE.speed * 1.0 * 0.1, 1.0)) < 0.05, "calm behind the front");
  assert.ok(Math.abs(rippleWave(RIPPLE.speed * 1.0 * 3, 1.0)) < 0.05, "calm in front of it");
  // Later still, the same crest is further out and lower.
  const later = rippleWave(RIPPLE.speed * 1.5, 1.5);
  assert.ok(Math.abs(later) < rippleWave(front, age));
  assert.equal(rippleWave(10, RIPPLE.life), 0);
  assert.equal(rippleWave(10, -1), 0);
});

test("the pointer drops rings by distance and time, at most `max` alive, and they expire", () => {
  const set = new RippleSet();
  set.trail([0, 0, 0], 0.016);
  assert.equal(set.items.length, 0, "the first sample only remembers the place");
  // Slow creeping drops nothing until it has travelled far enough.
  set.trail([1, 0, 0], 0.1);
  assert.equal(set.items.length, 0);
  set.trail([RIPPLE.spacing + 1, 0, 0], 0.1);
  assert.equal(set.items.length, 1);
  // Too soon after the last one: not yet, even if it moved far.
  set.trail([RIPPLE.spacing * 3, 0, 0], 0.01);
  assert.equal(set.items.length, 1);
  set.trail([RIPPLE.spacing * 5, 0, 0], 0.2);
  assert.equal(set.items.length, 2);
  for (let i = 0; i < 20; i++) set.drop(i, 0, 0);
  assert.equal(set.items.length, RIPPLE.max);
  set.advance(RIPPLE.life + 0.1);
  assert.equal(set.items.length, 0);
  assert.equal(set.active, false);
  // Leaving the picture forgets the path.
  set.trail(null, 0);
  set.trail([0, 0, 0], 0.1);
  set.trail(null, 0.1);
  set.trail([100, 0, 0], 0.1);
  assert.equal(set.items.length, 0);
});

test("the water at a point is the sum of the rings, pushing away from where they were dropped", () => {
  const set = new RippleSet();
  set.drop(0, 0, 0, 1);
  set.advance(0.4);
  const r = RIPPLE.speed * 0.4;
  const sample = set.sample(r, 0, 0, newSample());
  assert.ok(sample.wave > 0.2);
  assert.ok(sample.dx > 0 && Math.abs(sample.dy) < 1e-9 && Math.abs(sample.dz) < 1e-9, "away from the centre, along +x");
  const twin = new RippleSet();
  twin.drop(0, 0, 0, 1);
  twin.drop(0, 0, 0, 1);
  twin.advance(0.4);
  near(twin.sample(r, 0, 0).wave, sample.wave * 2, 1e-9);
  // A ring in the depth of the picture reaches a plate that is further from the point later than one that is nearer.
  assert.ok(Math.abs(set.sample(0, 0, -r * 3).wave) < 0.05);
});

// ───────────────────────────────────────────── cosmos ─────────────────────────────────────────────

const ASPECTS = [16 / 9, 4 / 3, 21 / 9];

test("every plate of the cosmos has a proper frame and stays inside (or just outside) the picture, within the camera's depth", () => {
  for (const aspect of ASPECTS) {
    for (const preset of [ringCamera(aspect), rowCamera(aspect)]) {
      const eye = eyeOf(preset, aspect);
      const frame = newPlate();
      const placed = newPlaced();
      for (let i = 0; i < 360; i++) {
        for (const time of [0, 7.3, 91]) {
          cosmosPlate(i, time, eye, [], null, frame, placed);
          assertFrame(frame, 1e-9);
          const at = project(preset, aspect, frame.p);
          assert.ok(at.u > -0.3 && at.u < 1.3 && at.v > -0.3 && at.v < 1.3, `plate ${i} at ${at.u.toFixed(2)},${at.v.toFixed(2)}`);
          assert.ok(at.depth > 0.5 * preset.distance && at.depth <= preset.distance + eye.reach + 4, `plate ${i} depth ${at.depth.toFixed(1)}`);
          assert.ok(placed.width > 0 && placed.height > 0 && placed.thickness > 0);
          assert.ok(placed.width < 6 && placed.height < 5);
        }
      }
    }
  }
  assert.ok(COSMOS.reach + 12 <= COSMOS.far);
});

test("the cosmos is the same every time, and moves slowly", () => {
  const eye = eyeOf(ringCamera(16 / 9), 16 / 9);
  const a = newPlate();
  const b = newPlate();
  const placed = newPlaced();
  cosmosPlate(17, 3, eye, [], null, a, placed);
  cosmosPlate(17, 3, eye, [], null, b, placed);
  assert.deepEqual(a, b);
  cosmosPlate(17, 3.1, eye, [], null, b, placed);
  const step = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  assert.ok(step > 0 && step < 0.6, `moved ${step} in a tenth of a second`);
  assert.ok(hash(5, 1) >= 0 && hash(5, 1) < 1);
});

test("plates in front of a card keep out of its rectangle; plates behind it may cross", () => {
  const aspect = 16 / 9;
  const preset = rowCamera(aspect);
  const eye = eyeOf(preset, aspect);
  const box: KeepOut = { x0: -0.45, y0: -0.4, x1: 0.2, y1: 0.5, distance: preset.distance + 6 };
  const frame = newPlate();
  const placed = newPlaced();
  let behind = 0;
  for (let i = 0; i < 360; i++) {
    cosmosPlate(i, 0, eye, [box], null, frame, placed);
    const at = project(preset, aspect, frame.p);
    const x = at.u * 2 - 1;
    const y = 1 - at.v * 2;
    const inside = x > box.x0 + 0.06 && x < box.x1 - 0.06 && y > box.y0 + 0.06 && y < box.y1 - 0.06;
    if (at.depth < box.distance - 3) assert.ok(!inside, `plate ${i} sits in front of the card, at ${x.toFixed(2)},${y.toFixed(2)}`);
    else if (inside) behind++;
  }
  assert.ok(behind > 3, "the plates behind the card are not cleared away, or the cosmos would have a hole in it");
});

test("keepClear slides a point to the edge of the ellipse along the line from the middle and never flips sides", () => {
  const box: KeepOut = { x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5, distance: 100 };
  const out = { u: 0, v: 0 };
  keepClear(0.1, 0.05, 90, [box], 0, out);
  const e = Math.hypot(out.u / (0.5 * 1.22), out.v / (0.5 * 1.22));
  near(e, 1, 1e-6);
  assert.ok(out.u > 0 && out.v > 0, "stays on its own side");
  keepClear(-0.1, 0.05, 90, [box], 0, out);
  assert.ok(out.u < 0);
  // Far behind the box nothing happens.
  keepClear(0.1, 0.05, 140, [box], 0, out);
  assert.equal(out.u, 0.1);
});

test("a ring passing through the cosmos lifts and lights the plates it reaches", () => {
  const aspect = 16 / 9;
  const preset = ringCamera(aspect);
  const eye = eyeOf(preset, aspect);
  const frame = newPlate();
  const calm = newPlate();
  const placed = newPlaced();
  const quiet = newPlaced();
  const away = (p: Vec3) => Math.hypot(p[0] - eye.aim[0], p[1] - eye.aim[1], p[2] - eye.aim[2]);
  // Where the plates lie with no water at all: the one nearest to the middle of the picture is the first that a ring dropped there reaches
  // (how far apart the plates lie is the cosmos' business, so the ring is timed to the plate and not the other way round).
  let first = 0;
  let firstAt = Infinity;
  for (let i = 0; i < 360; i++) {
    cosmosPlate(i, 0, eye, [], null, calm, quiet);
    if (away(calm.p) < firstAt) {
      firstAt = away(calm.p);
      first = i;
    }
  }
  assert.ok(firstAt / RIPPLE.speed < RIPPLE.life * 0.5, `the nearest plate is ${firstAt} away: a ring reaches it early in its life`);
  const ripples = new RippleSet();
  ripples.drop(eye.aim[0], eye.aim[1], eye.aim[2], 1);
  ripples.advance(firstAt / RIPPLE.speed);
  for (let i = 0; i < 360; i++) {
    cosmosPlate(i, 0, eye, [], ripples, frame, placed);
    cosmosPlate(i, 0, eye, [], null, calm, quiet);
    const towards = (frame.p[0] - calm.p[0]) * eye.toward[0] + (frame.p[1] - calm.p[1]) * eye.toward[1] + (frame.p[2] - calm.p[2]) * eye.toward[2];
    assert.equal(quiet.glow, 0);
    assertFrame(frame, 1e-9);
    if (i === first) {
      assert.ok(placed.glow > 0.2, `the plate under the front lights up (${placed.glow})`);
      assert.ok(Math.abs(towards) > 0.3, `and rises along the view axis (${towards})`);
    } else if (Math.abs(away(calm.p) - firstAt) > 20) {
      // Well clear of the front (the crest is only a few wavelengths wide), the water leaves a plate alone.
      assert.ok(placed.glow < 0.01, `plate ${i} is ${away(calm.p)} away and glows ${placed.glow}`);
    }
  }
});

// ───────────────────────────────────────────── halo ─────────────────────────────────────────────

test("the plates are split into 288 for the halo and 72 for the cosmos, each halo slot used once", () => {
  const seen = new Set<number>();
  let cosmos = 0;
  for (let i = 0; i < 360; i++) {
    const slot = haloSlot(i, 360);
    if (slot < 0) cosmos++;
    else {
      assert.ok(slot >= 0 && slot < HALO.count);
      assert.ok(!seen.has(slot), `slot ${slot} twice`);
      seen.add(slot);
    }
  }
  assert.equal(seen.size, HALO.count);
  assert.equal(cosmos, 72);
  // Neighbouring plates of the band wind into neighbouring places of the same ring.
  assert.equal(ringOf(haloSlot(0, 360)), ringOf(haloSlot(3, 360)));
  assert.equal(placeOf(haloSlot(1, 360)) - placeOf(haloSlot(0, 360)), 1);
  // A small mesh (fewer plates than slots) simply leaves the rest in the cosmos.
  assert.equal(haloSlot(50, 40), -1);
});

test("the halo's centre appears where the record is, at the record's size, and the plate leans back", () => {
  for (const [width, height] of [
    [1280, 720],
    [1000, 700],
    [1920, 1080],
  ]) {
    const aspect = width / height;
    const preset = ringCamera(aspect);
    const eye = eyeOf(preset, aspect);
    const layout = deckLayout({ width, height });
    const halo = haloFrame(eye, { width, height }, layout.record, DECK_TILT);
    const at = project(preset, aspect, halo.centre);
    near(at.u * width, layout.record.cx, 0.6);
    near(at.v * height, layout.record.cy, 0.6);
    // The record's horizontal radius, as seen: the point of the rim to the right of the centre.
    const rim: Vec3 = [halo.centre[0] + halo.right[0] * halo.radius, halo.centre[1] + halo.right[1] * halo.radius, halo.centre[2] + halo.right[2] * halo.radius];
    const rimAt = project(preset, aspect, rim);
    near((rimAt.u - at.u) * width, layout.record.radius, layout.record.radius * 0.01);
    // Right-handed and unit, and the normal points up and towards the viewer.
    near(dot(cross(halo.right, halo.back), halo.normal), 1, 1e-9);
    near(dot(halo.normal, eye.toward), Math.cos(DECK_TILT), 1e-9);
    assert.ok(dot(halo.back, eye.toward) < 0, "the far side of the plate is further from the viewer");
  }
});

test("halo plates stand on the plate, round the record, taller when louder", () => {
  const aspect = 16 / 9;
  const preset = ringCamera(aspect);
  const eye = eyeOf(preset, aspect);
  const layout = deckLayout({ width: 1280, height: 720 });
  const halo = haloFrame(eye, { width: 1280, height: 720 }, layout.record, DECK_TILT);
  const frame = newPlate();
  const placed = newPlaced();
  const quiet = newPlaced();
  for (let slot = 0; slot < HALO.count; slot++) {
    haloPlate(slot, halo, 0.8, 1.7, frame, placed);
    assertFrame(frame, 1e-9);
    const rel: Vec3 = [frame.p[0] - halo.centre[0], frame.p[1] - halo.centre[1], frame.p[2] - halo.centre[2]];
    // The plate's foot is on the plane of the record: its centre is half its height above it.
    near(dot(rel, halo.normal), placed.height / 2 + 0.002 * halo.radius, 1e-9);
    const flat = Math.hypot(dot(rel, halo.right), dot(rel, halo.back));
    near(flat, HALO.radii[ringOf(slot)] * halo.radius, 1e-9);
    haloPlate(slot, halo, 0, 1.7, frame, quiet);
    assert.ok(placed.height > quiet.height);
    assert.ok(placed.glow > quiet.glow);
    // The thin side points outwards, the tall side up.
    near(dot(frame.y, halo.normal), 1, 1e-9);
  }
  // The rings are different: the inner ring is taller at full volume.
  const inner = newPlaced();
  const outer = newPlaced();
  haloPlate(0, halo, 1, 0, frame, inner);
  haloPlate(HALO.per * 3, halo, 1, 0, frame, outer);
  assert.ok(inner.height > outer.height);
  // Alternate rings are shifted by half a step so that their plates do not line up.
  near(haloAngle(1, 0) - haloAngle(0, 0), Math.PI / HALO.per, 1e-12);
});
