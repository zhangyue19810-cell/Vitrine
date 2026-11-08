/**
 * The motions that connect the launcher's views. Every function here is pure: it maps (style, progress, a per-card
 * random seed) to an offset from the card's resting pose, so the motion can be tested without a GPU.
 *
 *   spiral   cards swirl in from far below and settle into place (home ring → download row), or swirl away downwards
 *   scatter  cards are pulled apart to both sides, each by its own irregular amount, and leave the picture
 *   gather   new cards fly in from all around, overshoot a little, and assemble into their places
 *
 * `enterOffset` runs from progress 0 (far away) to 1 (exactly at rest: the offset is the identity); `exitOffset` runs
 * from 0 (at rest) to 1 (gone). Angles are radians, applied on top of the resting orientation.
 *
 * `flightOffset` is for a card that does not disappear at all: when the ring turns into the row (or back) the same
 * archives travel from their old place to their new one. The stage interpolates the two poses; this function adds the
 * swirl on top (an offset that is zero at both ends) and the turn about the card's own vertical axis that flips its face.
 */

export type Style = "spiral" | "scatter" | "gather";

export interface Offset {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
}

export const identity = (): Offset => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, scale: 1 });

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeInCubic = (t: number) => clamp01(t) ** 3;
export const easeInOut = (t: number) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const easeOutQuint = (t: number) => 1 - (1 - clamp01(t)) ** 5;
/** Overshoots by about 8 % before settling at 1. */
export const easeOutBack = (t: number) => {
  t = clamp01(t);
  const c1 = 1.2;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export type Seed = [number, number, number, number];

/** Four reproducible numbers in [−1, 1] for card number `n` (an integer hash, so every run looks the same). */
export function seedOf(n: number): Seed {
  const out: Seed = [0, 0, 0, 0];
  let h = (Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    out[i] = (h / 0xffffffff) * 2 - 1;
  }
  return out;
}

/** Timing of a style: how long one card takes, and how far apart cards start. */
export const TIMING: Record<Style, { enter: number; exit: number; stagger: number; jitter: number }> = {
  spiral: { enter: 1.5, exit: 1.0, stagger: 0.085, jitter: 0.05 },
  scatter: { enter: 1.2, exit: 0.95, stagger: 0.03, jitter: 0.32 },
  gather: { enter: 1.3, exit: 1.0, stagger: 0.035, jitter: 0.4 },
};

/** Start delay of the `order`-th card (0 = first) of a transition, in seconds. */
export function delayOf(style: Style, order: number, seed: Seed): number {
  const timing = TIMING[style];
  return Math.max(0, order * timing.stagger + (seed[3] * 0.5 + 0.5) * timing.jitter);
}

const HELIX_TURNS = 1.35;

/** Helix position for a remaining fraction `u` (1 at the start of the swirl, 0 at the resting place). */
function helix(u: number, seed: Seed, out: Offset, down: boolean) {
  const radius = 16 * u * (0.7 + 0.3 * Math.abs(seed[0]));
  const phase = seed[1] * Math.PI + (down ? Math.PI : 0) + u * HELIX_TURNS * 2 * Math.PI;
  out.x = Math.cos(phase) * radius;
  out.z = Math.sin(phase) * radius * 0.7;
  out.y = -30 * u ** 1.25;
  out.yaw = u * 2.4 * Math.PI * (seed[2] < 0 ? -1 : 1);
  out.roll = u * 0.7 * seed[2];
  out.pitch = u * 0.35 * seed[0];
  out.scale = 0.45 + 0.55 * (1 - u) ** 0.5;
}

/** Offset of an arriving card: progress 0 → far away, 1 → at rest (the identity). */
export function enterOffset(style: Style, progress: number, seed: Seed, out: Offset = identity()): Offset {
  const t = clamp01(progress);
  Object.assign(out, identity());
  if (t >= 1) return out;
  if (style === "spiral") {
    helix(1 - easeOutQuint(t), seed, out, false);
  } else if (style === "scatter") {
    // Arrives from the side it left on, a little lower, as if pushed back into place.
    const u = 1 - easeOutCubic(t);
    const side = seed[0] < 0 ? -1 : 1;
    out.x = side * 34 * u;
    out.y = seed[1] * 5 * u;
    out.z = seed[2] * 8 * u;
    out.yaw = side * 1.3 * u;
    out.roll = seed[3] * 0.9 * u;
    out.scale = 0.7 + 0.3 * (1 - u);
  } else {
    // From a point on a shell around the picture, with a small overshoot and a tumble that unwinds.
    const u = 1 - easeOutBack(t);
    const azimuth = seed[0] * Math.PI;
    const polar = (seed[1] * 0.5 + 0.5) * Math.PI;
    const distance = 38 + 14 * Math.abs(seed[2]);
    out.x = Math.sin(polar) * Math.cos(azimuth) * distance * u;
    out.y = Math.cos(polar) * distance * 0.8 * u;
    out.z = Math.sin(polar) * Math.sin(azimuth) * distance * 0.6 * u;
    out.yaw = seed[3] * 3.0 * u;
    out.pitch = seed[2] * 1.4 * u;
    out.roll = seed[0] * 1.6 * u;
    out.scale = 0.55 + 0.45 * Math.min(1, 1 - u);
  }
  return out;
}

/** Offset of a leaving card: progress 0 → at rest (the identity), 1 → gone. */
export function exitOffset(style: Style, progress: number, seed: Seed, side = 0, out: Offset = identity()): Offset {
  const t = clamp01(progress);
  Object.assign(out, identity());
  if (t <= 0) return out;
  if (style === "spiral") {
    helix(easeInCubic(t), seed, out, true);
  } else if (style === "scatter") {
    // Pulled apart: left of centre goes left, right goes right, each by its own distance, with its own lift and twist.
    const e = easeInCubic(t);
    const direction = side !== 0 ? Math.sign(side) : seed[0] < 0 ? -1 : 1;
    out.x = direction * (5 + 36 * e) * (0.7 + 0.6 * Math.abs(seed[1]));
    out.y = seed[2] * 7 * e + 2.5 * Math.sin(t * Math.PI) * seed[3];
    out.z = seed[3] * 12 * e;
    out.yaw = direction * 1.5 * e * (0.5 + Math.abs(seed[2]));
    out.roll = seed[1] * 1.4 * e;
    out.pitch = seed[0] * 0.5 * e;
    out.scale = 1 - 0.35 * e;
  } else {
    // Sucked outwards and up, then away.
    const e = easeInCubic(t);
    out.x = seed[0] * 40 * e;
    out.y = 18 * e + seed[1] * 10 * e;
    out.z = seed[2] * 30 * e;
    out.yaw = seed[3] * 2.4 * e;
    out.roll = seed[1] * 1.2 * e;
    out.scale = 1 - 0.5 * e;
  }
  return out;
}

/** Longest time a transition of `count` cards can take (the last card to start plus its own duration). */
export function transitionLength(style: Style, count: number, phase: "enter" | "exit"): number {
  const timing = TIMING[style];
  return Math.max(0, count - 1) * timing.stagger + timing.jitter + timing[phase];
}

export interface Flight {
  x: number;
  y: number;
  z: number;
  /** Extra turn about the card's own vertical axis (a multiple of 2π at both ends, so the end pose is the plain target). */
  spin: number;
  /** Scale factor on top of the interpolated scale. */
  pop: number;
  /** Progress of the turn, 0 … 1: the face of the card may be swapped once it passes 0.5 (it is edge-on or facing away). */
  turn: number;
}

/** How a persistent card eases along its way (position, orientation and scale all use it). */
export const flightEase = (t: number) => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** Length of a flight in seconds, and how far apart the cards start. */
export const FLIGHT = { duration: 1.55, stagger: 0.05, jitter: 0.12 };

/** Start delay of the `order`-th moving card (0 = first). */
export function flightDelay(order: number, seed: Seed): number {
  return Math.max(0, order * FLIGHT.stagger + (seed[3] * 0.5 + 0.5) * FLIGHT.jitter);
}

/** Time the longest flight of `count` cards takes. */
export function flightLength(count: number): number {
  return Math.max(0, count - 1) * FLIGHT.stagger + FLIGHT.jitter + FLIGHT.duration;
}

/**
 * The swirl of a persistent card: `progress` is the linear time fraction 0 … 1 of its flight. The card dips below its
 * straight path and corkscrews around it (a helix whose radius is zero at both ends) while it turns once about its own
 * vertical axis. `side` is −1 or +1 (the way it turns).
 */
export function flightOffset(progress: number, seed: Seed, out: Flight = { x: 0, y: 0, z: 0, spin: 0, pop: 1, turn: 0 }): Flight {
  const t = clamp01(progress);
  const e = flightEase(t);
  const bell = Math.sin(Math.PI * e);
  const radius = (2.6 + 3.6 * Math.abs(seed[0])) * bell;
  const phase = seed[1] * Math.PI + e * 2 * Math.PI * 1.2;
  out.x = Math.cos(phase) * radius;
  out.z = Math.sin(phase) * radius * 0.8;
  out.y = -(3.2 + 2.8 * Math.abs(seed[2])) * bell;
  out.spin = 2 * Math.PI * (seed[2] < 0 ? -1 : 1) * e;
  out.pop = 1 + 0.07 * bell;
  out.turn = e;
  return out;
}
