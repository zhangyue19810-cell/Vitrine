import { BAND, type PlateFrame, type Vec3 } from "../fin-band";
import { hash, type Eye, type Placed } from "./cosmos";
import { SHADOW } from "./geodesic";
import { newSample, type RippleSample, type RippleSet } from "./ripples";

/**
 * The music world is a black hole and its accretion disk. Everything is laid out in the picture's terms ("the hole's shadow
 * stands this far across, the disk is seen from this far above its plane"), so it holds for any window shape, and measured in
 * horizon radii (the hole's own unit: its shadow is `SHADOW` ≈ 2.6 of them across, the disk begins at 2.3 and fades out at 16).
 * The 360 plates of the Möbius ring become the debris of the disk: they travel round the hole on Kepler's law (the inner ones are
 * the quick ones), lie in the plane of the disk and rock on the water the pointer drops there; a few stay out in the open as
 * wanderers. The cards of the page orbit on a lane of the disk, standing upright; the selected one stays at the front of the lane, a
 * little larger (its cover is read in the panel beside the picture). The cards are put away until the pointer goes to the right of the
 * picture: then the camera moves aside (the hole slides left, the disk tips open a little) and the lane turns so that the cards come
 * out along an arc on the right (`DISK.reveal`). The shader of `blackhole.ts` draws the light of the disk and
 * its lensed images; this file is the pure numbers that place everything else in step with it (`core/test/disk.test.ts`).
 */

const TAU = Math.PI * 2;
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

export const DISK = {
  /** Where the hole stands on the picture (−1 … 1, y up). */
  centre: { x: 0, y: 0.04 },
  /** The radius of its shadow as a share of half the picture's height — and never more than this share of half its width. */
  radius: 0.27,
  widthShare: 0.15,
  /** How far above the plane of the disk the viewer stands (radians), and how far the plane is turned on the picture. */
  elevation: 0.34,
  roll: 0.26,
  /** The disk's inner edge and the radius it has faded out at (horizon radii). */
  inner: 2.3,
  outer: 16,
  /** Angular speed (rad/s) of the disk at its inner edge: Kepler's law, ω ∝ r^−1.5, runs from there. */
  spin: 0.2,
  /** The share of the plates that wander in the open instead of travelling in the disk. */
  wander: 0.06,
  /** The lane the archives orbit on (horizon radii): the middle and the half-width kept free of debris. */
  lane: { radius: 8, half: 0.6 },
  /** The angle between two neighbouring cards on the lane, and how many places either side of the front are drawn. */
  slotAngle: 0.42,
  visible: 3.6,
  /** The selected card stays at the front of the lane, a little larger and nearer the viewer (its cover is read on the page beside the picture). */
  front: { forward: 2.2, size: 1.4, lift: 0.5 },
  /**
   * Bringing the cards out.
   *  - `zone`: the pointer is "at the right" beyond this (−1 … 1); `hold`: seconds the cards stay out after it leaves; `intro`: how long
   *    they stay out the first time the page is opened (so that it is seen they are there).
   *  - `pan`, `tilt`, `zoom`: how the camera moves while they are out: where the hole goes on the picture, the radians added to its
   *    elevation, and its size.
   *  - `arc`: where the selected card stands on the picture (−1 … 1), and `rise`: how far above the hole's own height (a share of half the
   *    picture's height: the places below it must not run into the controls at the bottom); `pitch`: the distance between two
   *    neighbouring places on the arc (the same share); `size`: how much larger a card is out than on the lane; `above`, `below`: how
   *    many places are drawn above / below the selected one (the top of the picture has the menu); `stagger`: how much later each place
   *    comes out (the selected card first).
   */
  reveal: { zone: 0.5, hold: 1.7, intro: 2.8, pan: -0.34, tilt: 0.3, zoom: 0.9, arc: 0.6, rise: 0.16, pitch: 0.3, size: 1.55, above: 1.9, below: 2.9, stagger: 0.2 },
} as const;

/** The bands of debris (horizon radii). `size`: the smallest and largest plate, relative to a plate of the Möbius ring. */
export const BANDS = [
  { inner: 2.45, outer: 3.7, weight: 0.24, size: [0.035, 0.07], tone: 1.6 },
  { inner: 3.8, outer: 6.9, weight: 0.2, size: [0.04, 0.09], tone: 1.15 },
  { inner: 8.9, outer: 11.2, weight: 0.3, size: [0.045, 0.11], tone: 0.85 },
  { inner: 11.4, outer: 14.5, weight: 0.2, size: [0.05, 0.13], tone: 0.6 },
  { inner: 14.8, outer: 18, weight: 0.06, size: [0.055, 0.15], tone: 0.4 },
] as const;
const WEIGHT_SUM = BANDS.reduce((sum, band) => sum + band.weight, 0);

/** How the water moves a piece of debris: it rises along the plane's normal, is pushed along the plane, and rolls. */
export const RING_WAVE = { lift: 1.5, push: 0.9, roll: 0.5 } as const;

/** The black hole's place and the plane of its disk, in the world. `right` and `back` lie in the plane (`back` points away from the viewer). */
export interface System {
  centre: Vec3;
  right: Vec3;
  /** The picture's up turned by the roll: with `right` and `toward`, the axes of the quad the hole is drawn on. */
  over: Vec3;
  back: Vec3;
  /** The disk's axis; right × back. */
  normal: Vec3;
  /** The picture's own axes: the cards stand upright on these. */
  up: Vec3;
  across: Vec3;
  toward: Vec3;
  /** Radius of the hole's shadow (world units); `rs` is its horizon, the unit of the disk. */
  radius: number;
  rs: number;
  /** How the viewer looks at the disk (see `DiskView`): how far above its plane (radians), how far the plane is turned on the picture, and the size. */
  elevation: number;
  roll: number;
  zoom: number;
  /** Where the hole stands on the picture (−1 … 1, y up) and half the picture's size, in world units, on the plane through it. */
  ndc: [number, number];
  halfWidth: number;
  halfHeight: number;
  /** 0 … 1: how far the cards are out (0: put away, 1: on the arc at the right). */
  reveal: number;
}

/** The three things the player can change about the picture of the hole, and the two the stage moves with the cards (`pan`, `reveal`). */
export interface ViewAngles {
  elevation: number;
  roll: number;
  zoom: number;
  /** How far the camera has moved aside: the hole's place on the picture is moved by this (−1 … 1 across the picture). */
  pan: number;
  /** 0 … 1: how far the cards are out. */
  reveal: number;
}

export const DEFAULT_VIEW: Readonly<ViewAngles> = { elevation: DISK.elevation, roll: DISK.roll, zoom: 1, pan: 0, reveal: 0 };

export const newSystem = (): System => ({
  centre: [0, 0, 0],
  right: [1, 0, 0],
  over: [0, 1, 0],
  back: [0, 0, -1],
  normal: [0, 1, 0],
  up: [0, 1, 0],
  across: [1, 0, 0],
  toward: [0, 0, 1],
  radius: 1,
  rs: 1 / SHADOW,
  elevation: DISK.elevation,
  roll: DISK.roll,
  zoom: 1,
  ndc: [DISK.centre.x, DISK.centre.y],
  halfWidth: 1,
  halfHeight: 1,
  reveal: 0,
});

/** The system as the picture of `eye` shows it, looked at as `view` says. */
export function systemOf(eye: Eye, out: System = newSystem(), view: Readonly<ViewAngles> = DEFAULT_VIEW): System {
  const [r0x, r0y, r0z] = eye.right;
  const [u0x, u0y, u0z] = eye.up;
  const [tx, ty, tz] = eye.toward;
  const cr = Math.cos(view.roll);
  const sr = Math.sin(view.roll);
  // The picture's plane turned by `roll`, then the disk tipped back so that the viewer stands `elevation` above it.
  const rx = r0x * cr + u0x * sr;
  const ry = r0y * cr + u0y * sr;
  const rz = r0z * cr + u0z * sr;
  const ux = -r0x * sr + u0x * cr;
  const uy = -r0y * sr + u0y * cr;
  const uz = -r0z * sr + u0z * cr;
  const se = Math.sin(view.elevation);
  const ce = Math.cos(view.elevation);
  out.elevation = view.elevation;
  out.roll = view.roll;
  out.zoom = view.zoom;
  out.reveal = view.reveal;
  out.right[0] = rx;
  out.right[1] = ry;
  out.right[2] = rz;
  out.over[0] = ux;
  out.over[1] = uy;
  out.over[2] = uz;
  out.back[0] = ux * se - tx * ce;
  out.back[1] = uy * se - ty * ce;
  out.back[2] = uz * se - tz * ce;
  out.normal[0] = ux * ce + tx * se;
  out.normal[1] = uy * ce + ty * se;
  out.normal[2] = uz * ce + tz * se;
  out.up[0] = u0x;
  out.up[1] = u0y;
  out.up[2] = u0z;
  out.across[0] = r0x;
  out.across[1] = r0y;
  out.across[2] = r0z;
  out.toward[0] = tx;
  out.toward[1] = ty;
  out.toward[2] = tz;
  const place = (nx: number, ny: number, forward: number, to: Vec3) => {
    to[0] = eye.aim[0] + r0x * nx * eye.halfWidth + u0x * ny * eye.halfHeight + tx * forward;
    to[1] = eye.aim[1] + r0y * nx * eye.halfWidth + u0y * ny * eye.halfHeight + ty * forward;
    to[2] = eye.aim[2] + r0z * nx * eye.halfWidth + u0z * ny * eye.halfHeight + tz * forward;
  };
  out.ndc[0] = DISK.centre.x + view.pan;
  out.ndc[1] = DISK.centre.y;
  out.halfWidth = eye.halfWidth;
  out.halfHeight = eye.halfHeight;
  place(out.ndc[0], out.ndc[1], 0, out.centre);
  out.radius = Math.min(DISK.radius * eye.halfHeight, DISK.widthShare * eye.halfWidth) * view.zoom;
  out.rs = out.radius / SHADOW;
  return out;
}

/** Which band debris `i` travels in (0 … 4), or −1 when it wanders in the open. */
export function bandOf(i: number): number {
  if (hash(i, 40) < DISK.wander) return -1;
  let pick = hash(i, 44) * WEIGHT_SUM;
  for (let k = 0; k < BANDS.length; k++) {
    pick -= BANDS[k].weight;
    if (pick <= 0) return k;
  }
  return BANDS.length - 1;
}

/** The radius (horizon radii) of a piece of debris of band `band`, from `u` in 0 … 1; it never lies on the lane. */
export const radiusIn = (band: number, u: number) => BANDS[band].inner + (BANDS[band].outer - BANDS[band].inner) * u;

/** How fast the disk goes round at radius `r` (horizon radii), in rad/s. */
export const omegaAt = (r: number) => DISK.spin * Math.pow(DISK.inner / r, 1.5);

/** The Doppler factor of debris at radius `r`, `theta` round the disk (0 on the right, counter-clockwise): above 1 on the left, which comes towards us. */
export function dopplerAt(r: number, theta: number, elevation: number = DISK.elevation): number {
  const beta = Math.sqrt(0.5 / Math.max(r, 1));
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return 1 / (gamma * (1 + beta * Math.cos(elevation) * Math.cos(theta)));
}

const scratch = { sample: newSample() as RippleSample };

/** Turn the axes `a` and `b` about the axis they are both perpendicular to, by `angle`, in place. */
function spin(angle: number, a: Vec3, b: Vec3) {
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
 * Plate `i`, a piece of debris of the disk, at `time` seconds. Writes its frame into `out` and its size, glow and heat into
 * `placed`; returns where it lies across the disk (0 at the inner edge … 1 at the outer one), which is what it listens to the
 * music by. Debris behind the hole is hidden by its shadow (the quad of the hole is drawn first, so the plates would otherwise
 * show through it).
 */
export function ringPlate(i: number, time: number, system: System, ripples: RippleSet | null, out: PlateFrame, placed: Placed): number {
  const k = Math.max(0, bandOf(i));
  const band = BANDS[k];
  const r = radiusIn(k, hash(i, 41));
  const theta = TAU * hash(i, 42) + omegaAt(r) * time;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const { right, back, normal, centre } = system;
  const radial: Vec3 = [right[0] * c + back[0] * s, right[1] * c + back[1] * s, right[2] * c + back[2] * s];
  const tangent: Vec3 = [-right[0] * s + back[0] * c, -right[1] * s + back[1] * c, -right[2] * s + back[2] * c];
  const distance = r * system.rs;
  // The disk has some thickness: a piece rides a little above or below the plane, and bobs.
  const height = ((hash(i, 45) - 0.5) * 0.9 + 0.18 * Math.sin(time * (0.4 + 0.5 * hash(i, 46)) + TAU * hash(i, 47))) * (0.6 + 0.4 * system.rs / 2.2);
  let px = centre[0] + radial[0] * distance + normal[0] * height;
  let py = centre[1] + radial[1] * distance + normal[1] * height;
  let pz = centre[2] + radial[2] * distance + normal[2] * height;

  // The piece lies in the plane, turned about its normal and rocking a little on its own account.
  const yaw = (hash(i, 48) - 0.5) * 2.6 + 0.12 * Math.sin(time * 0.2 + TAU * hash(i, 49));
  const ex: Vec3 = [radial[0], radial[1], radial[2]];
  const ey: Vec3 = [tangent[0], tangent[1], tangent[2]];
  const ez: Vec3 = [normal[0], normal[1], normal[2]];
  spin(yaw, ex, ey);
  let rockX = (hash(i, 50) - 0.5) * 0.85 + 0.22 * Math.sin(time * (0.35 + 0.4 * hash(i, 51)) + TAU * hash(i, 52));
  let rockY = (hash(i, 53) - 0.5) * 0.85 + 0.22 * Math.cos(time * (0.3 + 0.4 * hash(i, 54)) + TAU * hash(i, 55));
  let glow = 0;
  let grow = 1;
  if (ripples && ripples.active) {
    const sample = ripples.sample(px, py, pz, scratch.sample);
    if (sample.wave !== 0) {
      px += sample.dx * RING_WAVE.push + normal[0] * sample.wave * RING_WAVE.lift;
      py += sample.dy * RING_WAVE.push + normal[1] * sample.wave * RING_WAVE.lift;
      pz += sample.dz * RING_WAVE.push + normal[2] * sample.wave * RING_WAVE.lift;
      rockX += sample.wave * RING_WAVE.roll;
      rockY -= sample.wave * RING_WAVE.roll * 0.6;
      glow = Math.min(1, Math.abs(sample.wave) * 1.2);
      grow = 1 + 0.2 * Math.max(0, sample.wave);
    }
  }
  spin(rockX, ey, ez);
  spin(rockY, ez, ex);
  out.p[0] = px;
  out.p[1] = py;
  out.p[2] = pz;
  out.x = ex;
  out.y = ey;
  out.z = ez;

  const size = (band.size[0] + (band.size[1] - band.size[0]) * Math.pow(hash(i, 43), 1.9)) * grow * (system.rs / 2.2);
  placed.width = BAND.plate.width * size * (0.75 + 0.5 * hash(i, 56));
  placed.height = BAND.plate.height * size * (0.7 + 0.6 * hash(i, 57));
  placed.thickness = BAND.plate.thickness * Math.max(0.5, size * 1.4);
  placed.glow = glow;
  // Hotter inside, and brighter on the side that comes towards us.
  placed.heat = Math.pow(DISK.inner / r, 0.8) * Math.min(2.2, Math.pow(dopplerAt(r, theta, system.elevation), 2.2));

  // Behind the hole, and inside its shadow on the picture: hidden.
  const rx = px - centre[0];
  const ry = py - centre[1];
  const rz = pz - centre[2];
  if (rx * system.toward[0] + ry * system.toward[1] + rz * system.toward[2] < 0) {
    const sx = rx * system.across[0] + ry * system.across[1] + rz * system.across[2];
    const sy = rx * system.up[0] + ry * system.up[1] + rz * system.up[2];
    const reach = system.radius * 1.06 + 0.5 * placed.width;
    if (sx * sx + sy * sy < reach * reach) {
      placed.width = placed.height = placed.thickness = 1e-4;
    }
  }
  return (r - DISK.inner) / (DISK.outer - DISK.inner);
}

/** A card on the lane. */
export interface LanePose {
  p: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
  /** Size relative to a card of the Möbius ring: 0 where the card is out of sight. */
  scale: number;
}

export const newLanePose = (): LanePose => ({ p: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], scale: 1 });

/**
 * Where the card at `slot` stands (0: the selected card; negative to the left, positive to the right; a continuous number, so a
 * scroll slides the cards round the hole). `size` is the card size of the settings.
 *
 * Put away (`system.reveal` 0) the cards are nothing (size 0) on the lane round the hole. They come out when the camera moves aside:
 * each one turns from the lane onto an arc round the hole on the right of the picture, in the plane of the picture itself, the selected
 * card standing at `DISK.reveal.arc` and the others one `DISK.reveal.pitch` below (the next ones) or above it (the ones before), so
 * that a scroll slides them along the arc like the beads of a rosary. The selected card is a little larger and nearer the viewer.
 */
export function lanePose(slot: number, system: System, size: number, out: LanePose = newLanePose()): LanePose {
  const away = Math.abs(slot);
  const reveal = DISK.reveal;
  const { right, back, up, across, toward, centre } = system;
  // This card's own share of the coming-out: the front of the lane first, the others after it.
  const out01 = Math.max(0, Math.min(1, system.reveal * (1 + reveal.stagger * (reveal.below + 0.4)) - away * reveal.stagger));
  const turn = smooth(out01);
  const front = smooth(1 - away);
  const visible = DISK.visible + ((slot < 0 ? reveal.above : reveal.below) - DISK.visible) * turn;
  const shown = smooth((visible - away) / 0.9) * turn;
  const scale = 0.92 * size * (1 + (reveal.size - 1) * turn) * (1 + (DISK.front.size - 1) * front) * shown;

  // On the lane: a point of the circle in the plane of the disk, and up to the middle of the card (it stands on the lane).
  const phi = -Math.PI / 2 + slot * DISK.slotAngle;
  const home = DISK.lane.radius * system.rs;
  const lx = Math.cos(phi) * home;
  const ly = Math.sin(phi) * home;
  const lift = 1.85 * scale * 0.9 + DISK.front.lift * front;
  // On the arc: a circle round the hole that passes through the selected card, in the picture's own plane. The places are `pitch`
  // apart whatever the window's shape (the angle between them follows from the circle's size).
  const reach = Math.max(home, (reveal.arc - system.ndc[0]) * system.halfWidth);
  const theta = (-slot * reveal.pitch * system.halfHeight) / reach;
  const ax = Math.cos(theta) * reach;
  const ay = Math.sin(theta) * reach + reveal.rise * system.halfHeight;
  const forward = DISK.front.forward * front * system.rs;
  for (let k = 0; k < 3; k++) {
    const onLane = right[k] * lx + back[k] * ly + up[k] * lift;
    const onArc = across[k] * ax + up[k] * ay;
    out.p[k] = centre[k] + onLane + (onArc - onLane) * turn + toward[k] * forward;
  }
  // The cards on the lane fan out; on the arc they look a little towards the hole they circle.
  const yaw = 0.4 * Math.cos(phi) * (1 - front) * (1 - turn) - 0.3 * Math.cos(theta) * (1 - 0.6 * front) * turn;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  for (let k = 0; k < 3; k++) {
    out.x[k] = across[k] * cy - toward[k] * sy;
    out.y[k] = up[k];
    out.z[k] = toward[k] * cy + across[k] * sy;
  }
  out.scale = scale;
  return out;
}

/** The point where the line from `from` through `through` meets the plane of the disk (null if it never does). */
export function planePoint(system: System, from: Vec3, through: Vec3, out: Vec3 = [0, 0, 0]): Vec3 | null {
  const dx = through[0] - from[0];
  const dy = through[1] - from[1];
  const dz = through[2] - from[2];
  const n = system.normal;
  const denominator = n[0] * dx + n[1] * dy + n[2] * dz;
  if (Math.abs(denominator) < 1e-6) return null;
  const t = (n[0] * (system.centre[0] - from[0]) + n[1] * (system.centre[1] - from[1]) + n[2] * (system.centre[2] - from[2])) / denominator;
  out[0] = from[0] + dx * t;
  out[1] = from[1] + dy * t;
  out[2] = from[2] + dz * t;
  return out;
}
