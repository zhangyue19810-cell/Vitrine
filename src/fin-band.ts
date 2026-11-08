import { rowFrame } from "./row-track";

/**
 * The home screen's Möbius ring, built the way a card file is: hundreds of thin archive plates ("fins") stand one behind
 * the other along a figure-eight path, each rolled a little further about the path than the one before it, so the whole
 * band twists as it goes round and the plates read as fine ribs. The instance archives are a few of the plates, a little
 * taller than the rest, and the selected one is drawn out of the band to face the viewer.
 *
 * In the download view the same plates lie down along the row as a long ribbed track under the cards (see `trackPlateAt`).
 *
 * Pure numbers (no three.js) so the geometry can be tested on its own. Conventions: the ring lies in the XY plane and the
 * camera looks down −Z from +Z; a plate's axes are x (wide), y (tall) and z (thin: the way its big faces point), right-handed.
 */

export type Vec3 = [number, number, number];

export interface PlateFrame {
  /** Centre of the plate. */
  p: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const newPlate = (): PlateFrame => ({ p: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });

export const BAND = {
  /** Half the width of the figure eight (the x of its two tips), in world units; a cassette is 5 wide. */
  radius: 16,
  /** Vertical stretch of the figure eight (1 is the lemniscate's own proportions, which are very flat). */
  squash: 1.5,
  /** Half the front-to-back distance between the two strands where they cross. */
  depth: 5.2,
  /** Turns of roll about the path over one lap. A half-integer closes the band with a half twist: a Möbius band. */
  twist: 1.5,
  /** Roll at the start of the lap (radians). */
  phase: 0.35,
  /** How far each plate leans out of the square across the path (radians, at its most). */
  lean: 0.58,
  /** Size of the plates: wide, tall, thin. */
  plate: { width: 4.4, height: 3.7, thickness: 0.24 },
  /** Plates on the band. */
  count: 360,
  /** Radians of extra roll that the slow idle undulation adds (it travels along the band). */
  wave: 0.3,
  /** Lap fraction where the selected archive rests (the left tip of the figure eight), and where the lean flips. */
  focus: 0.5,
  seam: 0,
};

const TAU = Math.PI * 2;
const fract = (value: number) => value - Math.floor(value);
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/** The centre line at curve parameter `t` (radians): a lemniscate in XY with the strands pulled apart in Z. */
export function centreAt(t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const s = Math.sin(t);
  const c = Math.cos(t);
  const k = 1 / (1 + s * s);
  out[0] = BAND.radius * c * k;
  out[1] = BAND.radius * BAND.squash * s * c * k;
  out[2] = BAND.depth * s;
  return out;
}

/** Derivative of the centre line with respect to `t` (not normalised). */
export function velocityAt(t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const s = Math.sin(t);
  const c = Math.cos(t);
  const k = 1 / (1 + s * s);
  out[0] = -BAND.radius * s * k * (1 + 2 * c * c * k);
  out[1] = BAND.radius * BAND.squash * k * (c * c - s * s - 2 * s * s * c * c * k);
  out[2] = BAND.depth * c;
  return out;
}

/** The figure eight with its arc length tabulated, so that plates spaced evenly in lap fraction are spaced evenly in space. */
export class BandPath {
  readonly length: number;
  private readonly cumulative: Float64Array;

  constructor(private readonly samples = 720) {
    this.cumulative = new Float64Array(samples + 1);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    centreAt(0, a);
    for (let m = 1; m <= samples; m++) {
      centreAt((TAU * m) / samples, b);
      this.cumulative[m] = this.cumulative[m - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      a[0] = b[0];
      a[1] = b[1];
      a[2] = b[2];
    }
    this.length = this.cumulative[samples];
  }

  /** Curve parameter (radians, 0 … 2π) at lap fraction `lap` of the arc length; `lap` wraps. */
  param(lap: number): number {
    const target = fract(lap) * this.length;
    let low = 0;
    let high = this.samples;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (this.cumulative[mid] <= target) low = mid;
      else high = mid;
    }
    const span = this.cumulative[high] - this.cumulative[low] || 1;
    return (TAU * (low + (target - this.cumulative[low]) / span)) / this.samples;
  }
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= length;
  v[1] /= length;
  v[2] /= length;
  return v;
};

const scratch = { v: [0, 0, 0] as Vec3, c: [0, 0, 0] as Vec3 };

/**
 * The plate standing at lap fraction `lap` (0 … 1, wraps) at time `clock` seconds.
 *
 * Across the path the plate is rolled by φ = phase + twist·t (+ a slow wave); its thin axis leans out of the path by an
 * angle that changes sign once per lap and is zero half way round. That matters: after one lap the roll has turned by an
 * odd number of half turns, which turns "leaning left" into "leaning right"; letting the lean pass through zero keeps
 * the plates continuous across the closing of the band, with no seam.
 */
export function plateAt(path: BandPath, lap: number, clock: number, out: PlateFrame = newPlate()): PlateFrame {
  const t = path.param(lap);
  centreAt(t, out.p);
  const v = velocityAt(t, scratch.v);
  const tx = unit(v)[0];
  const ty = v[1];
  const tz = v[2];
  // Reference across the path: the way towards the viewer, made perpendicular to the path.
  const nx = -tz * tx;
  const ny = -tz * ty;
  const nz = 1 - tz * tz;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const n0x = nx / nl;
  const n0y = ny / nl;
  const n0z = nz / nl;
  // b0 = T × N0
  const b0x = ty * n0z - tz * n0y;
  const b0y = tz * n0x - tx * n0z;
  const b0z = tx * n0y - ty * n0x;

  const phi = BAND.phase + BAND.twist * t + BAND.wave * (Math.sin(3 * t + clock * 0.45) + 0.25 * Math.sin(7 * t - clock * 0.8));
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const wx = cp * n0x + sp * b0x;
  const wy = cp * n0y + sp * b0y;
  const wz = cp * n0z + sp * b0z;
  // h = T × W
  const hx = ty * wz - tz * wy;
  const hy = tz * wx - tx * wz;
  const hz = tx * wy - ty * wx;

  const lean = BAND.lean * Math.cos(Math.PI * fract(lap - BAND.seam));
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  out.x[0] = wx;
  out.x[1] = wy;
  out.x[2] = wz;
  out.y[0] = cl * hx - sl * tx;
  out.y[1] = cl * hy - sl * ty;
  out.y[2] = cl * hz - sl * tz;
  out.z[0] = cl * tx + sl * hx;
  out.z[1] = cl * ty + sl * hy;
  out.z[2] = cl * tz + sl * hz;
  return out;
}

/**
 * The same plate turned about its thin axis by `angle` (in its own plane): an archive that comes round the band is
 * turned over once per lap by exactly the amount the roll flips it, so it is never upside down where it can be read.
 */
export function turnPlate(plate: PlateFrame, angle: number): PlateFrame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let axis = 0; axis < 3; axis++) {
    const x = plate.x[axis];
    const y = plate.y[axis];
    plate.x[axis] = c * x + s * y;
    plate.y[axis] = -s * x + c * y;
  }
  return plate;
}

/** The extra turn (0 … π) an archive needs at lap fraction `lap`: it flips over while it passes the far side, away from the focus. */
export function lapFlip(lap: number, window = 0.18): number {
  const u = fract(lap - BAND.seam);
  return Math.PI * smooth((u - (1 - window)) / window);
}

/**
 * The download view's track: the plates lie down along the row, one behind the other, leaning like shingles. `u` runs
 * 0 … 1 along it.
 */
export const TRACK = {
  from: -3.4,
  to: 10.8,
  halfWidth: 2.9,
  drop: 2.05,
  lean: 1.05,
  plate: { width: 5.8, height: 1.7, thickness: 0.2 },
};

/** Where on the track (in row slots) the plate at `u` lies. */
export const trackSlot = (u: number) => TRACK.from + (TRACK.to - TRACK.from) * u;

const rowScratch = { frame: { point: [0, 0, 0] as Vec3, tangent: [1, 0, 0] as Vec3, width: [0, 1, 0] as Vec3, normal: [0, 0, 1] as Vec3, angle: 0, roll: 0 } };

export function trackPlateAt(u: number, out: PlateFrame = newPlate()): PlateFrame {
  const frame = rowFrame(trackSlot(u), rowScratch.frame);
  const tx = frame.tangent[0];
  const tz = frame.tangent[2];
  const nx = frame.normal[0];
  const nz = frame.normal[2];
  const cl = Math.cos(TRACK.lean);
  const sl = Math.sin(TRACK.lean);
  out.p[0] = frame.point[0];
  out.p[1] = frame.point[1] - TRACK.drop;
  out.p[2] = frame.point[2];
  // x: across the track; y = −cosλ·up + sinλ·T; z = cosλ·T + sinλ·up
  out.x[0] = nx;
  out.x[1] = 0;
  out.x[2] = nz;
  out.y[0] = sl * tx;
  out.y[1] = -cl;
  out.y[2] = sl * tz;
  out.z[0] = cl * tx;
  out.z[1] = sl;
  out.z[2] = cl * tz;
  return out;
}

/** Centre of the left loop's opening: where the selected archive hangs while it is read. */
export function holeCentre(out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = -BAND.radius * 0.5;
  out[1] = 0;
  out[2] = 0;
  return out;
}

/** Per-plate order of the unrolling: 0 at the focus, 1 on the opposite side of the lap (both ways round). */
export function unrollOrder(lap: number, focus: number = BAND.focus): number {
  const d = fract(lap - focus);
  return 2 * Math.min(d, 1 - d);
}

/** The plate's own progress (0 … 1) through a morph of overall progress `morph`, staggered by `order` (0 … 1). */
export function staggered(morph: number, order: number, spread = 0.55): number {
  return smooth((morph * (1 + spread) - spread * order) / 1);
}
