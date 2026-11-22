/**
 * Light round a black hole that does not turn (Schwarzschild), in units where its horizon has radius 1.
 *
 * A ray of light lies in one plane through the hole. In it, with u = 1/r and φ the angle swept round the hole, the path obeys
 *
 *     d²u/dφ² = −u + 3/2 · u²        (du/dφ)² = 1/b² − u² (1 − u)
 *
 * where b, the impact parameter, is how far from the hole the ray would pass if it went straight. Rays with b below
 * `SHADOW` = 3√3/2 ≈ 2.598 fall in; the rest are bent and escape (the closer to `SHADOW`, the more turns they make round the
 * photon sphere at r = 1.5 first). That one equation is all the renderer needs: seen from far away, every pixel is a ray with
 * a b and a plane, so the point where it crosses the plane of the disk is found from the table of u(φ; b) built here, instead
 * of by marching every ray every frame. The table is a small texture (`buildDeflectionTable`); the shader reads it.
 * Pure numbers, tested in `core/test/geodesic.test.ts`.
 */

export const HORIZON = 1;
export const PHOTON_SPHERE = 1.5;
/** The critical impact parameter: the radius of the black hole's shadow on the picture. */
export const SHADOW = (3 * Math.sqrt(3)) / 2;

/** What the table covers. `power` spends more of its columns on the small impact parameters, where the rays change fastest. */
export const TABLE = {
  width: 1536,
  height: 512,
  /** The largest impact parameter in the table (beyond it nothing of the disk is in view). */
  bMax: 20,
  power: 1.6,
  /** The largest angle (radians) swept round the hole: four crossings of the disk's plane are possible. */
  phiMax: 4 * Math.PI + 0.3,
} as const;

/** Impact parameter of column `x` (0 … width − 1) of the table. */
export const impactOf = (x: number, width: number = TABLE.width, bMax: number = TABLE.bMax, power: number = TABLE.power) =>
  bMax * Math.pow(x / (width - 1), power);

/** Column (fractional) of impact parameter `b`: the inverse of `impactOf`. */
export const columnOf = (b: number, width: number = TABLE.width, bMax: number = TABLE.bMax, power: number = TABLE.power) =>
  (width - 1) * Math.pow(Math.max(0, Math.min(1, b / bMax)), 1 / power);

export interface Ray {
  /** Angle swept at each sample. */
  phi: Float64Array;
  /** 1/r at each sample: 1 once the ray has fallen in, 0 once it has gone. */
  u: Float64Array;
  /** du/dφ at each sample. */
  du: Float64Array;
  /** The angle at which the ray fell in or got away (Infinity if it did neither in range). */
  end: number;
  fell: boolean;
}

/**
 * Follow the ray of impact parameter `b` from far away (u = 0 at φ = 0), writing `samples` points up to `phiMax`. Fourth-order
 * Runge–Kutta, `substeps` steps between two samples.
 */
export function traceRay(b: number, samples: number, phiMax: number, substeps = 2): Ray {
  const phi = new Float64Array(samples);
  const u = new Float64Array(samples);
  const du = new Float64Array(samples);
  const dphi = phiMax / (samples - 1);
  const h = dphi / substeps;
  let end = Infinity;
  let fell = false;
  let state = 0; // 0 flying, 1 fell in, 2 got away
  let x = 0;
  let v = 1 / Math.max(b, 1e-3);
  const accel = (position: number) => -position + 1.5 * position * position;
  for (let i = 0; i < samples; i++) {
    phi[i] = i * dphi;
    if (state === 1) {
      u[i] = 1;
      du[i] = 0;
    } else if (state === 2) {
      u[i] = 0;
      du[i] = 0;
    } else {
      u[i] = x;
      du[i] = v;
    }
    if (i === samples - 1 || state !== 0) continue;
    for (let s = 0; s < substeps; s++) {
      const before = x;
      const k1x = v;
      const k1v = accel(x);
      const k2x = v + 0.5 * h * k1v;
      const k2v = accel(x + 0.5 * h * k1x);
      const k3x = v + 0.5 * h * k2v;
      const k3v = accel(x + 0.5 * h * k2x);
      const k4x = v + h * k3v;
      const k4v = accel(x + h * k3x);
      x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
      v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      const here = i * dphi + (s + 1) * h;
      if (x >= 1) {
        state = 1;
        fell = true;
        end = here;
        break;
      }
      if (x <= 0 && v < 0) {
        state = 2;
        // Where, within the step, u crossed zero.
        end = here - h + (h * before) / Math.max(before - x, 1e-12);
        break;
      }
    }
  }
  return { phi, u, du, end, fell };
}

/** Where the ray of impact parameter `b` is at angle `phi` (1/r and du/dφ), by interpolating a traced ray. */
export function sampleRay(ray: Ray, phi: number): { u: number; du: number } {
  const last = ray.phi.length - 1;
  const at = Math.max(0, Math.min(last, (phi / ray.phi[last]) * last));
  const i = Math.min(last - 1, Math.floor(at));
  const f = at - i;
  return { u: ray.u[i] + (ray.u[i + 1] - ray.u[i]) * f, du: ray.du[i] + (ray.du[i + 1] - ray.du[i]) * f };
}

/** The total angle a ray of impact parameter `b > SHADOW` sweeps from far away to far away: π plus its deflection. */
export function totalAngle(b: number, phiMax = 6 * Math.PI): number {
  const ray = traceRay(b, 3000, phiMax, 2);
  return ray.fell ? Infinity : ray.end;
}

export interface DeflectionTable {
  width: number;
  height: number;
  /** Interleaved (u, du/dφ), row by row: the row is the angle, the column the impact parameter. */
  data: Float32Array;
  /** The same as half-precision floats (what the GPU texture holds). */
  half: Uint16Array;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** `value` as an IEEE half-precision float (the bits), rounded to nearest. */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exponent = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    return sign | (((mantissa | 0x800000) >> (1 - exponent)) + 0x1000 >> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  // Adding (not or-ing) lets a rounding carry go on into the exponent.
  return sign | ((exponent << 10) + ((mantissa + 0x1000) >> 13));
}

/**
 * Builds the table a few columns at a time, so that the page does not stop for the 100 ms or so that the whole of it takes:
 * `step(budget)` traces columns until the budget (milliseconds) is spent.
 */
export class TableBuilder {
  readonly table: DeflectionTable;
  private next = 0;

  constructor(
    private readonly width: number = TABLE.width,
    private readonly height: number = TABLE.height,
    private readonly bMax: number = TABLE.bMax,
    private readonly power: number = TABLE.power,
    private readonly phiMax: number = TABLE.phiMax,
  ) {
    this.table = { width, height, data: new Float32Array(width * height * 2), half: new Uint16Array(width * height * 2) };
  }

  get done(): boolean {
    return this.next >= this.width;
  }

  /** How much of the table is traced (0 … 1). */
  get progress(): number {
    return this.next / this.width;
  }

  /** Trace columns for up to `budget` milliseconds. Returns true once the table is complete. */
  step(budget: number, now: () => number = () => performance.now()): boolean {
    const started = now();
    const { width, height, table } = this;
    while (this.next < width) {
      const x = this.next++;
      const ray = traceRay(impactOf(x, width, this.bMax, this.power), height, this.phiMax, 2);
      for (let y = 0; y < height; y++) {
        const at = (y * width + x) * 2;
        table.data[at] = ray.u[y];
        table.data[at + 1] = ray.du[y];
        table.half[at] = toHalf(ray.u[y]);
        table.half[at + 1] = toHalf(ray.du[y]);
      }
      if (now() - started >= budget) break;
    }
    return this.done;
  }
}

/** Trace one ray per column and store 1/r and du/dφ at every row's angle. */
export function buildDeflectionTable(width: number = TABLE.width, height: number = TABLE.height, bMax: number = TABLE.bMax, power: number = TABLE.power, phiMax: number = TABLE.phiMax): DeflectionTable {
  const builder = new TableBuilder(width, height, bMax, power, phiMax);
  builder.step(Number.POSITIVE_INFINITY);
  return builder.table;
}

/**
 * Doppler factor of a spot of the disk that moves at speed `beta` (a share of the speed of light) along `v`, seen along the
 * direction `k` the light travels towards the viewer (both unit vectors): above 1 where it comes towards us, below 1 where it
 * goes away. The shader repeats this.
 */
export function doppler(beta: number, v: readonly [number, number, number], k: readonly [number, number, number]): number {
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return 1 / (gamma * (1 - beta * (v[0] * k[0] + v[1] * k[1] + v[2] * k[2])));
}

/** Speed of a circular orbit at radius `r` (horizon radii) as a share of the speed of light: v² = GM/r = 1/(2r). */
export const orbitSpeed = (r: number) => Math.sqrt(1 / (2 * r));
