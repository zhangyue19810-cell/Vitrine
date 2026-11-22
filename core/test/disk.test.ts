import assert from "node:assert/strict";
import test from "node:test";
import { newPlate, type PlateFrame, type Vec3 } from "../../src/fin-band";
import { eyeOf, hash, newPlaced } from "../../src/space/cosmos";
import { BANDS, DEFAULT_VIEW, DISK, bandOf, dopplerAt, lanePose, newLanePose, newSystem, omegaAt, planePoint, radiusIn, ringPlate, systemOf, type System, type ViewAngles } from "../../src/space/disk";
import { SHADOW } from "../../src/space/geodesic";
import { ringCamera } from "../../src/stage-layout";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const eyeFor = (aspect: number) => eyeOf(ringCamera(aspect), aspect);
const systemFor = (aspect: number, view: Partial<ViewAngles> = {}): System => systemOf(eyeFor(aspect), newSystem(), { ...DEFAULT_VIEW, ...view });
/** Where a point of the world lies on the picture (−1 … 1, y up), as the system sees it. */
const onPicture = (system: System, p: Vec3): [number, number] => {
  const d = minus(p, system.centre);
  return [system.ndc[0] + dot(d, system.across) / system.halfWidth, system.ndc[1] + dot(d, system.up) / system.halfHeight];
};
/** The cards of the page, out on the right of the picture: the camera has moved aside and the lane has turned onto its arc. */
const OUT = { pan: DISK.reveal.pan, reveal: 1 } as const;

function assertFrame(frame: { x: Vec3; y: Vec3; z: Vec3 }, eps = 1e-9) {
  near(length(frame.x), 1, eps);
  near(length(frame.y), 1, eps);
  near(length(frame.z), 1, eps);
  near(dot(frame.x, frame.y), 0, eps);
  near(dot(frame.y, frame.z), 0, eps);
  near(dot(frame.x, frame.z), 0, eps);
  near(dot(cross(frame.x, frame.y), frame.z), 1, eps);
}

// ───────────────────────────────────────────── the system ─────────────────────────────────────────────

test("the disk's axes are unit vectors at right angles and the picture's own axes are the eye's, for any view of the disk", () => {
  for (const aspect of [16 / 9, 4 / 3, 1]) {
    const eye = eyeFor(aspect);
    for (const view of [DEFAULT_VIEW, { ...DEFAULT_VIEW, elevation: 0.9, roll: -0.8 }, { ...DEFAULT_VIEW, elevation: 0.05, roll: 1.1, zoom: 2 }]) {
      const s = systemOf(eye, newSystem(), view);
      for (const axis of [s.right, s.back, s.normal, s.over, s.up, s.across, s.toward]) near(length(axis), 1);
      near(dot(s.right, s.back), 0);
      near(dot(s.right, s.normal), 0);
      near(dot(s.back, s.normal), 0);
      const turned = cross(s.right, s.back);
      for (let k = 0; k < 3; k++) near(turned[k], s.normal[k]);
      for (let k = 0; k < 3; k++) {
        near(s.up[k], eye.up[k]);
        near(s.across[k], eye.right[k]);
        near(s.toward[k], eye.toward[k]);
      }
      // The viewer stands `elevation` above the plane of the disk.
      near(dot(s.normal, s.toward), Math.sin(view.elevation));
      // `back` points away from the viewer (or lies across the picture when seen exactly edge-on), whatever the roll.
      assert.ok(dot(s.back, s.toward) < 0.0001);
    }
  }
});

test("the hole stands at the composition's place plus the camera's pan, and is as large as the window's width and height allow", () => {
  const eye = eyeFor(16 / 9);
  const home = systemOf(eye, newSystem(), DEFAULT_VIEW);
  near(home.ndc[0], DISK.centre.x);
  near(home.ndc[1], DISK.centre.y);
  for (let k = 0; k < 3; k++) {
    near(home.centre[k], eye.aim[k] + eye.right[k] * home.ndc[0] * eye.halfWidth + eye.up[k] * home.ndc[1] * eye.halfHeight);
  }
  // Moving the camera aside slides the hole along the picture's width and only that.
  const aside = systemOf(eye, newSystem(), { ...DEFAULT_VIEW, pan: DISK.reveal.pan });
  near(aside.ndc[0], DISK.centre.x + DISK.reveal.pan);
  near(dot(minus(aside.centre, home.centre), eye.right), DISK.reveal.pan * eye.halfWidth);
  near(dot(minus(aside.centre, home.centre), eye.up), 0);
  near(dot(minus(aside.centre, home.centre), eye.toward), 0);
  assert.equal(aside.radius, home.radius, "it is as large as before");

  // The radius of the shadow is the smaller of its two limits; the horizon is the shadow's radius over the shadow's factor.
  for (const aspect of [16 / 9, 3, 1, 0.6]) {
    const e = eyeFor(aspect);
    for (const zoom of [0.55, 1, 2.6]) {
      const s = systemOf(e, newSystem(), { ...DEFAULT_VIEW, zoom });
      const byHeight = DISK.radius * e.halfHeight * zoom;
      const byWidth = DISK.widthShare * e.halfWidth * zoom;
      near(s.radius, Math.min(byHeight, byWidth));
      near(s.rs, s.radius / SHADOW);
      assert.equal(s.zoom, zoom);
    }
  }
  // A wide window is limited by its height, a narrow one by its width.
  assert.ok(DISK.radius * eyeFor(3).halfHeight < DISK.widthShare * eyeFor(3).halfWidth);
  assert.ok(DISK.radius * eyeFor(0.6).halfHeight > DISK.widthShare * eyeFor(0.6).halfWidth);
  // `reveal` is handed on, and the object that is given is the one that is filled.
  const given = newSystem();
  assert.equal(systemOf(eye, given, { ...DEFAULT_VIEW, reveal: 0.4 }), given);
  assert.equal(given.reveal, 0.4);
});

// ───────────────────────────────────────────── the debris ─────────────────────────────────────────────

test("the debris is spread over five bands by their weights, a few wander, and none lies on the lane of the cards", () => {
  const seen = new Array<number>(BANDS.length + 1).fill(0);
  const count = 6000;
  for (let i = 0; i < count; i++) seen[bandOf(i) + 1]++;
  near(seen[0] / count, DISK.wander, 0.02);
  const sum = BANDS.reduce((total, band) => total + band.weight, 0);
  BANDS.forEach((band, k) => near(seen[k + 1] / count, ((1 - DISK.wander) * band.weight) / sum, 0.03));
  for (const band of BANDS) {
    assert.ok(band.inner < band.outer);
    assert.ok(band.outer <= DISK.lane.radius - DISK.lane.half || band.inner >= DISK.lane.radius + DISK.lane.half, `${band.inner}–${band.outer} meets the lane`);
    near(radiusIn(BANDS.indexOf(band), 0), band.inner);
    near(radiusIn(BANDS.indexOf(band), 1), band.outer);
  }
  // The bands are in order from the hole outwards and do not overlap.
  for (let k = 1; k < BANDS.length; k++) assert.ok(BANDS[k].inner > BANDS[k - 1].outer);
  assert.ok(BANDS[0].inner >= DISK.inner);
});

test("the disk turns by Kepler's law, and the side that comes towards us is brighter, the more so close to the hole", () => {
  near(omegaAt(DISK.inner), DISK.spin);
  near(omegaAt(DISK.inner * 4), DISK.spin / 8);
  let last = Infinity;
  for (let r = DISK.inner; r <= 18; r += 0.5) {
    assert.ok(omegaAt(r) < last, `r ${r}`);
    last = omegaAt(r);
  }
  for (const r of [2.5, 5, 10, 16]) {
    assert.ok(dopplerAt(r, Math.PI) > 1, `the left side comes towards us at r ${r}`);
    assert.ok(dopplerAt(r, 0) < 1, `the right side goes away at r ${r}`);
    near(dopplerAt(r, Math.PI / 2), dopplerAt(r, -Math.PI / 2), 1e-12);
  }
  assert.ok(dopplerAt(2.5, Math.PI) > dopplerAt(10, Math.PI));
  // Seen edge-on, the effect is at its largest; seen from the pole, there is none along the line of sight.
  assert.ok(dopplerAt(5, Math.PI, 0) > dopplerAt(5, Math.PI, 1.2));
});

test("every piece of debris lies in the plane of the disk at its own radius, goes round at its own speed, and is hidden when it is in the hole's shadow", () => {
  const system = systemFor(16 / 9);
  const frame = newPlate();
  const placed = newPlaced();
  const rs = system.rs;
  for (let i = 0; i < 360; i++) {
    const listen = ringPlate(i, 3.7, system, null, frame, placed);
    assertFrame(frame, 1e-9);
    assert.ok(listen >= 0 && listen < 1.25, `plate ${i} listens at ${listen}`);
    const d = minus(frame.p, system.centre);
    const planar = Math.hypot(dot(d, system.right), dot(d, system.back));
    const radius = radiusIn(Math.max(0, bandOf(i)), hash(i, 41));
    near(planar, radius * rs, 1e-6);
    // Above or below the plane by no more than the disk's thickness.
    assert.ok(Math.abs(dot(d, system.normal)) <= 0.63 * (0.6 + (0.4 * rs) / 2.2) + 1e-9, `plate ${i} stands off the plane`);
    assert.ok(placed.width > 0 && placed.height > 0 && placed.thickness > 0);
    assert.ok((placed.heat ?? 0) > 0);
    // Behind the hole and inside its shadow on the picture: nothing of it is left to show.
    if (dot(d, system.toward) < 0) {
      const shadow = Math.hypot(dot(d, system.across), dot(d, system.up));
      if (shadow < system.radius * 1.06) assert.ok(placed.width < 0.001, `plate ${i} shows through the hole`);
    }
  }
  // Every plate that is shown sits outside the shadow if it is behind the hole.
  for (let i = 0; i < 360; i++) {
    ringPlate(i, 11.3, system, null, frame, placed);
    const d = minus(frame.p, system.centre);
    if (placed.width > 0.001 && dot(d, system.toward) < 0) {
      assert.ok(Math.hypot(dot(d, system.across), dot(d, system.up)) >= system.radius * 1.06, `plate ${i}`);
    }
  }
  // The inner pieces go round faster than the outer ones, each by the disk's angular speed at its own radius.
  const angleOf = (f: PlateFrame) => {
    const d = minus(f.p, system.centre);
    return Math.atan2(dot(d, system.back), dot(d, system.right));
  };
  const first = BANDS.map((_, band) => {
    for (let i = 0; i < 360; i++) if (bandOf(i) === band) return i;
    throw new Error(`no plate in band ${band}`);
  });
  let lastSpeed = Infinity;
  for (const i of first) {
    ringPlate(i, 0, system, null, frame, placed);
    const before = angleOf(frame);
    ringPlate(i, 1, system, null, frame, placed);
    const turn = Math.atan2(Math.sin(angleOf(frame) - before), Math.cos(angleOf(frame) - before));
    near(turn, omegaAt(radiusIn(bandOf(i), hash(i, 41))), 1e-9);
    assert.ok(turn < lastSpeed, "outwards, slower");
    lastSpeed = turn;
  }
});

// ───────────────────────────────────────────── the cards ─────────────────────────────────────────────

test("put away, the cards are nothing; they come out one after another, the selected card first", () => {
  const away = systemFor(16 / 9);
  for (let slot = -3; slot <= 4; slot += 0.5) assert.equal(lanePose(slot, away, 1).scale, 0, `slot ${slot}`);
  const early = systemFor(16 / 9, { reveal: 0.2, pan: DISK.reveal.pan * 0.2 });
  const [s0, s1, s2] = [0, 1, 2].map((slot) => lanePose(slot, early, 1).scale);
  assert.ok(s0 > 0, "the selected card has begun to come out");
  assert.ok(s1 > 0 && s1 < s0, "the next one follows it");
  assert.equal(s2, 0, "the one after that has not yet");
  // Out, they all are (up to the edge of the window of places), and none is out of order.
  const out = systemFor(16 / 9, OUT);
  assert.ok(lanePose(0, out, 1).scale > lanePose(1, out, 1).scale, "the selected card is the largest");
  assert.ok(lanePose(1, out, 1).scale > 0);
  assert.ok(lanePose(2, out, 1).scale > 0);
});

test("out, the selected card stands where `arc` says, a little above the hole, and the others follow it down the arc, pitch apart whatever the window's shape", () => {
  for (const aspect of [16 / 9, 21 / 9, 4 / 3, 1]) {
    const system = systemFor(aspect, OUT);
    const eye = eyeFor(aspect);
    const poses = [-1, 0, 1, 2].map((slot) => lanePose(slot, system, 1));
    const spots = poses.map((pose) => onPicture(system, pose.p));
    // The selected card.
    near(spots[1][0], DISK.reveal.arc, 1e-9);
    near(spots[1][1], DISK.centre.y + DISK.reveal.rise, 1e-9);
    // Down the arc: each next place is lower; they bend towards the hole (the lowest are nearer the hole's own side).
    assert.ok(spots[0][1] > spots[1][1] && spots[1][1] > spots[2][1] && spots[2][1] > spots[3][1], `aspect ${aspect}: ${JSON.stringify(spots)}`);
    // The distance between two places, on the picture's plane, is `pitch` of half the picture's height (the chord of a short arc).
    for (let k = 1; k < spots.length; k++) {
      const gap = Math.hypot((spots[k][0] - spots[k - 1][0]) * eye.halfWidth, (spots[k][1] - spots[k - 1][1]) * eye.halfHeight);
      near(gap / (DISK.reveal.pitch * eye.halfHeight), 1, 0.012);
    }
    // Everything is in front of the hole's own plane: no card is behind the picture.
    for (const pose of poses) assert.ok(dot(minus(pose.p, system.centre), system.toward) >= -1e-9);
    // The cards stay on the picture, below the menu and above the capsule.
    assert.ok(spots[0][1] < 0.8, `aspect ${aspect}: the card before the selected one is at ${spots[0][1]}`);
    assert.ok(spots[3][1] > -0.55, `aspect ${aspect}: the last card is at ${spots[3][1]}`);
    for (const [x] of spots) assert.ok(x > 0.2 && x < 0.95, `aspect ${aspect}: x ${x}`);
  }
});

test("more places are drawn below the selected card than above it (the menu is at the top), and they fade out at the end of the window", () => {
  const system = systemFor(16 / 9, OUT);
  const scale = (slot: number) => lanePose(slot, system, 1).scale;
  assert.ok(DISK.reveal.above < DISK.reveal.below);
  assert.ok(scale(-1) > 0, "one above");
  assert.equal(scale(-2), 0, "not two");
  assert.ok(scale(2) > 0, "two below");
  assert.equal(scale(3), 0, "not three");
  // Between the last place and nothing, the card thins out gradually rather than vanishing.
  assert.ok(scale(2.5) > 0 && scale(2.5) < scale(2));
  assert.ok(scale(-1.5) > 0 && scale(-1.5) < scale(-1));
  // A card out is larger than one on the lane, and the card size of the settings scales them all.
  near(scale(0), 0.92 * DISK.reveal.size * DISK.front.size, 1e-9);
  near(lanePose(0, system, 1.5).scale, 1.5 * scale(0), 1e-9);
  near(lanePose(2, system, 0.8).scale, 0.8 * scale(2), 1e-9);
});

test("the selected card comes forward; the others stand in the picture's plane, upright, and look a little towards the hole", () => {
  const system = systemFor(16 / 9, OUT);
  const front = lanePose(0, system, 1);
  near(dot(minus(front.p, system.centre), system.toward), DISK.front.forward * system.rs, 1e-9);
  const behind = lanePose(2, system, 1);
  near(dot(minus(behind.p, system.centre), system.toward), 0, 1e-9);
  for (const slot of [-1, 0, 0.5, 1, 2, 2.5]) {
    for (const reveal of [0, 0.3, 0.7, 1]) {
      const s = systemFor(16 / 9, { reveal, pan: DISK.reveal.pan * reveal });
      const pose = lanePose(slot, s, 1);
      assertFrame(pose, 1e-9);
      for (let k = 0; k < 3; k++) near(pose.y[k], s.up[k]);
    }
  }
  // Out, a card on the arc (right of the hole) turns its face a little towards the hole: its normal leans to the left of the picture.
  assert.ok(dot(behind.z, system.across) < 0, "it looks left, at the hole");
  assert.ok(Math.abs(dot(behind.z, system.across)) < 0.4, "but only a little");
});

test("a scroll slides the cards smoothly along the arc, and the coming-out of one card is smooth too (no card jumps)", () => {
  for (const reveal of [0.4, 1]) {
    const system = systemFor(16 / 9, { reveal, pan: DISK.reveal.pan * reveal });
    let last = lanePose(-1.5, system, 1);
    let lastP: Vec3 = [last.p[0], last.p[1], last.p[2]];
    let lastScale = last.scale;
    for (let slot = -1.49; slot <= 3.5; slot += 0.01) {
      last = lanePose(slot, system, 1, last);
      assert.ok(length(minus(last.p, lastP)) < 0.35, `reveal ${reveal}, slot ${slot.toFixed(2)}: it moved ${length(minus(last.p, lastP))}`);
      assert.ok(Math.abs(last.scale - lastScale) < 0.12, `reveal ${reveal}, slot ${slot.toFixed(2)}: its size jumped`);
      lastP = [last.p[0], last.p[1], last.p[2]];
      lastScale = last.scale;
    }
  }
  for (const slot of [0, 1, 2]) {
    let pose = lanePose(slot, systemFor(16 / 9), 1);
    let lastP: Vec3 = [pose.p[0], pose.p[1], pose.p[2]];
    let lastScale = pose.scale;
    for (let reveal = 0.01; reveal <= 1.0001; reveal += 0.01) {
      pose = lanePose(slot, systemFor(16 / 9, { reveal, pan: DISK.reveal.pan * reveal }), 1, pose);
      assert.ok(length(minus(pose.p, lastP)) < 3, `slot ${slot}, reveal ${reveal.toFixed(2)}: it moved ${length(minus(pose.p, lastP))}`);
      assert.ok(Math.abs(pose.scale - lastScale) < 0.15, `slot ${slot}, reveal ${reveal.toFixed(2)}: its size jumped`);
      lastP = [pose.p[0], pose.p[1], pose.p[2]];
      lastScale = pose.scale;
    }
  }
});

test("lanePose fills the pose it is given and allocates one when it is not given any", () => {
  const system = systemFor(16 / 9, OUT);
  const given = newLanePose();
  assert.equal(lanePose(1, system, 1, given), given);
  const made = lanePose(1, system, 1);
  assert.notEqual(made, given);
  assert.deepEqual(made, given);
});

// ───────────────────────────────────────────── the pointer ─────────────────────────────────────────────

test("a ray through a point of the disk's plane meets the plane there, and a ray along the plane never does", () => {
  const system = systemFor(16 / 9);
  const eye: Vec3 = [system.centre[0] + system.toward[0] * 200, system.centre[1] + system.toward[1] * 200, system.centre[2] + system.toward[2] * 200];
  const target: Vec3 = [
    system.centre[0] + system.right[0] * 7 + system.back[0] * -3,
    system.centre[1] + system.right[1] * 7 + system.back[1] * -3,
    system.centre[2] + system.right[2] * 7 + system.back[2] * -3,
  ];
  const hit = planePoint(system, eye, target);
  assert.ok(hit);
  for (let k = 0; k < 3; k++) near(hit[k], target[k], 1e-6);
  // Beyond the plane, or on this side of it: still on the line.
  const beyond: Vec3 = [target[0] + (target[0] - eye[0]), target[1] + (target[1] - eye[1]), target[2] + (target[2] - eye[2])];
  const again = planePoint(system, eye, beyond);
  assert.ok(again);
  for (let k = 0; k < 3; k++) near(again[k], target[k], 1e-6);
  // A line that runs along the plane (in it, or parallel to it) never meets it.
  const [cx, cy, cz] = system.centre;
  assert.equal(planePoint(system, [cx, cy, cz], [cx + system.right[0], cy + system.right[1], cz + system.right[2]]), null);
  const over: Vec3 = [cx + system.normal[0] * 3, cy + system.normal[1] * 3, cz + system.normal[2] * 3];
  assert.equal(planePoint(system, over, [over[0] + system.back[0], over[1] + system.back[1], over[2] + system.back[2]]), null);
});

test("the numbers that bring the cards out are sound: where the pointer must be, how long they stay, how the camera moves", () => {
  const { reveal } = DISK;
  assert.ok(reveal.zone > 0 && reveal.zone < 1, "the zone is a part of the picture's right");
  assert.ok(reveal.hold > 0 && reveal.intro > reveal.hold, "the first showing is longer than the later ones");
  assert.ok(reveal.pan < 0, "the hole goes left, to make room");
  assert.ok(reveal.zoom <= 1 && reveal.zoom > 0.5, "the hole gets no larger");
  assert.ok(reveal.arc > reveal.zone, "the cards stand within the zone that brings them");
  assert.ok(reveal.size > 1);
  assert.ok(reveal.stagger > 0 && reveal.stagger < 0.5);
  // The camera's pan leaves the hole's whole shadow on the picture.
  const aside = systemFor(16 / 9, { pan: reveal.pan, zoom: reveal.zoom });
  assert.ok(aside.ndc[0] - (aside.radius * 2.2) / aside.halfWidth > -1, "the disk's inner part stays in the picture");
});
