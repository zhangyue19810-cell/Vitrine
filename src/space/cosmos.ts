import { BAND, newPlate, type PlateFrame, type Vec3 } from "../fin-band";
import { basisOf, type CameraPreset } from "../stage-layout";
import { newSample, type RippleSample, type RippleSet } from "./ripples";

/**
 * The cosmos: where the archive plates go when the picture becomes a piece of deep space. Every plate floats somewhere in
 * the volume in front of the camera (laid out in the picture's own terms: "this far across, this far up, this far away", so
 * it holds for any camera and any window shape), drifts slowly, tumbles a little, and answers the water rings the pointer
 * drops (`ripples.ts`). Plates that are in front of the cards stay out of the cards' way. Pure numbers: tests live in
 * `core/test/space.test.ts`.
 */

/** Cheap deterministic number in [0, 1) for plate `i` (and salt): the same recipe as the ring's per-plate variation. */
export const hash = (i: number, salt = 0) => {
  const x = Math.sin(i * 127.1 + salt * 311.7 + 17.3) * 43758.5453;
  return x - Math.floor(x);
};

const TAU = Math.PI * 2;
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

export const COSMOS = {
  /** Share of the plates that float in front of the picture plane, round its edge (the rest are behind it). */
  nearShare: 0.04,
  /** Plate size relative to the plates of the ring: the smallest and the largest. */
  scale: { min: 0.22, max: 0.6 },
  /** How hard a ripple pushes a plate aside / lifts it towards the viewer (world units at power 1). */
  push: 1.5,
  lift: 2.4,
  /** The camera's far plane leaves this much room behind the aim plane, at most. */
  reach: 78,
  /** The far plane of the stage's camera. */
  far: 300,
} as const;

/** The camera's frame, in the terms the cosmos needs. */
export interface Eye {
  aim: Vec3;
  right: Vec3;
  up: Vec3;
  /** Unit vector from the aim towards the camera. */
  toward: Vec3;
  /** Camera distance from the aim. */
  distance: number;
  /** World half height / half width of the picture on the plane through the aim. */
  halfHeight: number;
  halfWidth: number;
  /** How far behind the aim plane plates may float. */
  reach: number;
}

export function eyeOf(preset: CameraPreset, aspect: number, far: number = COSMOS.far): Eye {
  const { right, up, forward } = basisOf(preset);
  return {
    aim: [preset.aim[0], preset.aim[1], preset.aim[2]],
    right,
    up,
    toward: [-forward[0], -forward[1], -forward[2]],
    distance: preset.distance,
    halfHeight: preset.span / 2,
    halfWidth: (preset.span * aspect) / 2,
    reach: Math.max(24, Math.min(COSMOS.reach, far - preset.distance - 12)),
  };
}

/** A part of the picture that plates in front of it must leave free (cards, the record, the lyrics). Picture units: −1…1, y up. */
export interface KeepOut {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Plates nearer to the camera than this (world units) keep out; a little further back they may pass behind. */
  distance: number;
}

/** What a placed plate looks like (world units) and how much it is lit. */
export interface Placed {
  width: number;
  height: number;
  thickness: number;
  /** 0 … 1: how far the plate takes on the glow colour. */
  glow: number;
  /** How hot the plate is (the disk of the music world: 0 cool … 1.5 white-hot); unset elsewhere. */
  heat?: number;
}

export const newPlaced = (): Placed => ({ width: BAND.plate.width, height: BAND.plate.height, thickness: BAND.plate.thickness, glow: 0 });

type V = Vec3;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Turn the unit vectors `a` and `b` (perpendicular to each other and to the axis they turn about, taken in right-handed order
 * axis → a → b) by `angle` about that axis, in place: a rotation of their plane.
 */
function spin(angle: number, a: V, b: V) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ax = a[0] * c + b[0] * s;
  const ay = a[1] * c + b[1] * s;
  const az = a[2] * c + b[2] * s;
  b[0] = b[0] * c - a[0] * s;
  b[1] = b[1] * c - a[1] * s;
  b[2] = b[2] * c - a[2] * s;
  a[0] = ax;
  a[1] = ay;
  a[2] = az;
}

/**
 * Move a point of the picture (−1…1) out of every keep-out rectangle that lies behind it: it is slid along the line from the
 * rectangle's middle to the point, to the edge of the (slightly enlarged) ellipse around the rectangle. The direction comes from
 * the point's own position, which does not change from frame to frame, so a plate never flips sides.
 */
export function keepClear(u: number, v: number, distance: number, keep: readonly KeepOut[], fallback: number, out: { u: number; v: number }) {
  out.u = u;
  out.v = v;
  for (const box of keep) {
    const weight = 1 - smooth((distance - box.distance + 2) / 12);
    if (weight <= 0.001) continue;
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    // The ellipse round the rectangle is a little larger than it, so that the corners are covered too.
    const hx = Math.max(0.02, ((box.x1 - box.x0) / 2) * 1.22);
    const hy = Math.max(0.02, ((box.y1 - box.y0) / 2) * 1.22);
    const dx = out.u - cx;
    const dy = out.v - cy;
    const e = Math.hypot(dx / hx, dy / hy);
    if (e >= 1) continue;
    let nx: number;
    let ny: number;
    if (e < 1e-3) {
      nx = Math.cos(fallback * TAU);
      ny = Math.sin(fallback * TAU);
    } else {
      nx = dx / hx / e;
      ny = dy / hy / e;
    }
    out.u += (cx + nx * hx - out.u) * weight;
    out.v += (cy + ny * hy - out.v) * weight;
  }
}

const scratch = { clear: { u: 0, v: 0 }, sample: newSample() as RippleSample };

/**
 * Plate `i` of the cosmos at `time` seconds, seen through `eye`. Writes its frame into `out` and its size and glow into `placed`.
 */
export function cosmosPlate(i: number, time: number, eye: Eye, keep: readonly KeepOut[], ripples: RippleSet | null, out: PlateFrame, placed: Placed) {
  const D = eye.distance;
  const near = hash(i, 12) < COSMOS.nearShare;
  let u: number;
  let v: number;
  let distance: number;
  if (near) {
    // In front of the picture plane: only at its rim, so that they frame the picture and never cover it.
    distance = D * (0.62 + 0.3 * hash(i, 13));
    const u0 = hash(i, 10) * 2 - 1;
    const v0 = hash(i, 11) * 2 - 1;
    const m = Math.max(Math.abs(u0), Math.abs(v0), 0.05);
    const rim = 0.92 + 0.3 * hash(i, 14);
    u = (u0 / m) * rim;
    v = (v0 / m) * rim;
  } else {
    distance = D + 8 + (eye.reach - 8) * Math.pow(hash(i, 13), 0.8);
    u = (hash(i, 10) * 2 - 1) * 1.12;
    v = (hash(i, 11) * 2 - 1) * 1.08;
  }
  keepClear(u, v, distance, keep, hash(i, 15), scratch.clear);
  u = scratch.clear.u;
  v = scratch.clear.v;

  // Slow drift: each plate wanders on its own small loop.
  u += 0.034 * Math.sin(time * (0.07 + 0.09 * hash(i, 20)) + TAU * hash(i, 21));
  v += 0.034 * Math.cos(time * (0.06 + 0.08 * hash(i, 22)) + TAU * hash(i, 23));
  distance += 3 * Math.sin(time * 0.05 * (1 + hash(i, 24)) + TAU * hash(i, 25));

  const scale = COSMOS.scale.min + (COSMOS.scale.max - COSMOS.scale.min) * Math.pow(hash(i, 26), 1.7);
  const perspective = distance / D;
  const x = u * eye.halfWidth * perspective;
  const y = v * eye.halfHeight * perspective;
  const back = D - distance;
  let px = eye.aim[0] + eye.toward[0] * back + eye.right[0] * x + eye.up[0] * y;
  let py = eye.aim[1] + eye.toward[1] * back + eye.right[1] * x + eye.up[1] * y;
  let pz = eye.aim[2] + eye.toward[2] * back + eye.right[2] * x + eye.up[2] * y;

  // The water: rings the pointer dropped push the plate aside, lift it towards the viewer and light it.
  let yaw = (hash(i, 16) - 0.5) * 1.5 + 0.3 * Math.sin(time * 0.11 + TAU * hash(i, 27));
  let pitch = (hash(i, 17) - 0.5) * 1.2 + 0.25 * Math.cos(time * 0.09 + TAU * hash(i, 28));
  const roll = (hash(i, 18) - 0.5) * 1.6 + time * (hash(i, 19) - 0.5) * 0.12;
  let glow = 0;
  let grow = 1;
  if (ripples && ripples.active) {
    const sample = ripples.sample(px, py, pz, scratch.sample);
    if (sample.wave !== 0) {
      const push = COSMOS.push * perspective;
      px += sample.dx * push + eye.toward[0] * sample.wave * COSMOS.lift;
      py += sample.dy * push + eye.toward[1] * sample.wave * COSMOS.lift;
      pz += sample.dz * push + eye.toward[2] * sample.wave * COSMOS.lift;
      // The plate leans with the water: away from the ring that passes.
      const right = dot([sample.dx, sample.dy, sample.dz], eye.right);
      const up = dot([sample.dx, sample.dy, sample.dz], eye.up);
      yaw += right * 0.5;
      pitch -= up * 0.5;
      glow = Math.min(1, Math.abs(sample.wave) * 1.2);
      grow = 1 + 0.22 * Math.max(0, sample.wave);
    }
  }

  // Orientation: facing the viewer, then turned by the plate's own yaw, pitch and roll.
  const ex: V = [eye.right[0], eye.right[1], eye.right[2]];
  const ey: V = [eye.up[0], eye.up[1], eye.up[2]];
  const ez: V = [eye.toward[0], eye.toward[1], eye.toward[2]];
  spin(pitch, ey, ez);
  spin(yaw, ez, ex);
  spin(roll, ex, ey);
  out.p[0] = px;
  out.p[1] = py;
  out.p[2] = pz;
  out.x = ex;
  out.y = ey;
  out.z = ez;

  const size = scale * grow * (0.8 + 0.2 * perspective);
  placed.width = BAND.plate.width * size;
  placed.height = BAND.plate.height * size;
  placed.thickness = BAND.plate.thickness * size;
  placed.glow = glow;
}

/** A fresh frame, for callers that keep their own. */
export const newCosmosFrame = (): PlateFrame => newPlate();
