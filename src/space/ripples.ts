import type { Vec3 } from "../mobius-ring";

/**
 * Water rings for the cosmos. Moving the pointer drops a ring into space at the place it points to; the ring spreads as a
 * spherical wave, and every plate (and star) the shell passes through rises towards the viewer, is pushed aside and lights
 * up. Only plain numbers live here, so the physics is tested on its own; the star shader repeats `rippleWave`.
 */

export interface Ripple {
  /** Where the ring was dropped (world space). */
  x: number;
  y: number;
  z: number;
  /** Seconds since. */
  age: number;
  /** 0 … ~1.6: how hard the pointer hit the water. */
  power: number;
}

export const RIPPLE = {
  /** How fast a ring spreads (world units per second). */
  speed: 15,
  /** Distance between two crests (world units). */
  wavelength: 3.8,
  /** Seconds a ripple lives. */
  life: 3,
  /** Rings alive at the same time (the shaders' arrays have this size). */
  max: 8,
  /** The pointer drops a ring every this much travel on the plane of the water (world units) … */
  spacing: 3.4,
  /** … but not more often than this (seconds). */
  gap: 0.06,
} as const;

/** Height (−1 … 1) of the water `distance` away from where a ripple of age `age` was dropped. */
export function rippleWave(distance: number, age: number): number {
  if (age < 0 || age >= RIPPLE.life) return 0;
  const offset = distance - RIPPLE.speed * age;
  const width = RIPPLE.wavelength * (0.85 + 0.3 * age);
  const envelope = Math.exp(-(offset * offset) / (2 * width * width));
  const fade = Math.pow(1 - age / RIPPLE.life, 1.6);
  const spread = 1 / (1 + distance * 0.035);
  // A little swell at the very start, so a fresh ring does not begin as a spike.
  const rise = Math.min(1, age / 0.08);
  return envelope * Math.cos((offset / RIPPLE.wavelength) * Math.PI * 2) * fade * spread * rise;
}

/** `rippleWave` in GLSL (without its distance fall-off: callers add their own), shared by every shader that draws the water. */
export const RIPPLE_GLSL = /* glsl */ `
const float RIPPLE_SPEED = ${RIPPLE.speed.toFixed(3)};
const float RIPPLE_LAMBDA = ${RIPPLE.wavelength.toFixed(3)};
const float RIPPLE_LIFE = ${RIPPLE.life.toFixed(3)};
float ringWave(float d, float age) {
  if (age < 0.0 || age >= RIPPLE_LIFE) return 0.0;
  float offset = d - RIPPLE_SPEED * age;
  float width = RIPPLE_LAMBDA * (0.85 + 0.3 * age);
  float envelope = exp(-(offset * offset) / (2.0 * width * width));
  float fade = pow(1.0 - age / RIPPLE_LIFE, 1.6);
  float rise = min(1.0, age / 0.08);
  return envelope * cos(offset / RIPPLE_LAMBDA * 6.2831853) * fade * rise;
}`;

export interface RippleSample {
  /** Sum of the waves here (signed): the water's height. */
  wave: number;
  /** The same, as a push away from the rings' centres (world space). */
  dx: number;
  dy: number;
  dz: number;
}

export const newSample = (): RippleSample => ({ wave: 0, dx: 0, dy: 0, dz: 0 });

export class RippleSet {
  readonly items: Ripple[] = [];
  /** Bumped whenever the picture of the water changes (for the "same frame" check). */
  version = 0;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastZ = Number.NaN;
  private travel = 0;
  private since = 1;

  get active(): boolean {
    return this.items.length > 0;
  }

  /** Drop a ring (a click is a hard one: `power` 1.6). */
  drop(x: number, y: number, z: number, power = 1) {
    if (this.items.length >= RIPPLE.max) this.items.shift();
    this.items.push({ x, y, z, age: 0, power });
    this.version++;
  }

  /**
   * The pointer is at `point` on the focus plane (or has left: null). Rings are dropped along its path, spaced by the distance
   * travelled and by time, harder the faster it goes.
   */
  trail(point: Vec3 | null, dt: number) {
    this.since += dt;
    if (!point) {
      this.lastX = this.lastY = this.lastZ = Number.NaN;
      this.travel = 0;
      return;
    }
    if (Number.isNaN(this.lastX)) {
      this.lastX = point[0];
      this.lastY = point[1];
      this.lastZ = point[2];
      return;
    }
    const step = Math.hypot(point[0] - this.lastX, point[1] - this.lastY, point[2] - this.lastZ);
    this.lastX = point[0];
    this.lastY = point[1];
    this.lastZ = point[2];
    this.travel += step;
    if (this.travel < RIPPLE.spacing || this.since < RIPPLE.gap) return;
    const speed = this.travel / Math.max(this.since, 1e-3);
    this.drop(point[0], point[1], point[2], Math.max(0.45, Math.min(1.2, 0.45 + speed / 140)));
    this.travel = 0;
    this.since = 0;
  }

  advance(dt: number) {
    if (this.items.length === 0) return;
    for (const ripple of this.items) ripple.age += dt;
    const before = this.items.length;
    let write = 0;
    for (const ripple of this.items) if (ripple.age < RIPPLE.life) this.items[write++] = ripple;
    this.items.length = write;
    if (write !== before || write > 0) this.version++;
  }

  clear() {
    if (this.items.length === 0) return;
    this.items.length = 0;
    this.version++;
  }

  /** The water at world point `p`: the sum of all rings. */
  sample(px: number, py: number, pz: number, out: RippleSample = newSample()): RippleSample {
    out.wave = out.dx = out.dy = out.dz = 0;
    for (const ripple of this.items) {
      const rx = px - ripple.x;
      const ry = py - ripple.y;
      const rz = pz - ripple.z;
      const distance = Math.hypot(rx, ry, rz);
      const wave = rippleWave(distance, ripple.age) * ripple.power;
      if (wave === 0) continue;
      out.wave += wave;
      const inverse = distance > 1e-4 ? wave / distance : 0;
      out.dx += rx * inverse;
      out.dy += ry * inverse;
      out.dz += rz * inverse;
    }
    return out;
  }
}
