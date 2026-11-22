import type { PlateFrame, Vec3 } from "../fin-band";
import type { Eye, Placed } from "./cosmos";

/**
 * The halo: while a song is open the plates of the Möbius ring wind into concentric rings round the record on the turntable
 * and stand on it like the bars of a round equaliser. The record's page is laid out in the picture's terms (`deckLayout`), the
 * halo is that layout put into the world through the camera: its centre is where the record's centre appears, its radius is the
 * record's radius, and the plane of the plate leans back by `tilt` from facing the viewer. Pure numbers.
 */

export const HALO = {
  rings: 4,
  per: 72,
  count: 288,
  /** Radii of the rings in record radii (the plinth under them reaches 1.46). */
  radii: [1.14, 1.245, 1.35, 1.455] as const,
  /** Height of a plate at rest and at full volume, in record radii, ring by ring. */
  rest: 0.035,
  peak: [0.6, 0.48, 0.38, 0.3] as const,
  /** Share of the room round the circle that a plate fills. */
  fill: 0.62,
} as const;

const TAU = Math.PI * 2;

/** The page of the record in the world. `right`, `back` and `normal` are unit vectors (right-handed): `back` points to the far side of the plate. */
export interface Halo {
  centre: Vec3;
  right: Vec3;
  back: Vec3;
  normal: Vec3;
  /** Radius of the record (world units). */
  radius: number;
}

/**
 * Where the record is, from its place on the picture (`record`: centre and radius in px on a `view`-sized picture) and the
 * camera `eye`: on the plane through the aim, `tilt` radians back from facing the viewer.
 */
export function haloFrame(eye: Eye, view: { width: number; height: number }, record: { cx: number; cy: number; radius: number }, tilt: number): Halo {
  const nx = (record.cx / view.width) * 2 - 1;
  const ny = 1 - (record.cy / view.height) * 2;
  const centre: Vec3 = [
    eye.aim[0] + eye.right[0] * nx * eye.halfWidth + eye.up[0] * ny * eye.halfHeight,
    eye.aim[1] + eye.right[1] * nx * eye.halfWidth + eye.up[1] * ny * eye.halfHeight,
    eye.aim[2] + eye.right[2] * nx * eye.halfWidth + eye.up[2] * ny * eye.halfHeight,
  ];
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return {
    centre,
    right: [eye.right[0], eye.right[1], eye.right[2]],
    back: [c * eye.up[0] - s * eye.toward[0], c * eye.up[1] - s * eye.toward[1], c * eye.up[2] - s * eye.toward[2]],
    normal: [s * eye.up[0] + c * eye.toward[0], s * eye.up[1] + c * eye.toward[1], s * eye.up[2] + c * eye.toward[2]],
    radius: (record.radius / view.height) * 2 * eye.halfHeight,
  };
}

/** Which place of the halo plate `i` of `count` takes (0 … 287), or −1 when it stays out in the cosmos: every fifth plate does. */
export function haloSlot(i: number, count: number): number {
  if (i % 5 === 4) return -1;
  const slot = i - Math.floor(i / 5);
  return slot < Math.min(HALO.count, count) ? slot : -1;
}

/** The ring (0 … 3) and the place round it (0 … 71) of a halo slot: consecutive plates of the band wind into the same ring. */
export const ringOf = (slot: number) => Math.min(HALO.rings - 1, Math.floor(slot / HALO.per));
export const placeOf = (slot: number) => slot % HALO.per;

/**
 * Which part of the spectrum (0 … 1, bass → treble) a halo plate listens to: the front of the ring (towards the viewer) gets the
 * bass, the back the treble, both sides mirror each other, and every ring is a few steps round from the one inside it, so the
 * rings do not all move alike.
 */
export function haloBand(slot: number): number {
  const t = ((placeOf(slot) + ringOf(slot) * 5) % HALO.per) / HALO.per;
  return Math.min(t, 1 - t) * 2;
}

/** The angle (radians) of the plate at `place` of `ring`, counter-clockwise from the front; alternate rings are shifted by half a step. */
export const haloAngle = (ring: number, place: number) => ((place + (ring % 2) * 0.5) / HALO.per) * TAU;

/**
 * Halo slot `slot` standing at `level` (0 … 1, how loud its band is) at `time` seconds. With no music (`level` 0) the plates sink
 * low and a faint swell runs round the rings, so the halo is never dead.
 */
export function haloPlate(slot: number, halo: Halo, level: number, time: number, out: PlateFrame, placed: Placed) {
  const ring = ringOf(slot);
  const a = haloAngle(ring, placeOf(slot));
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const swell = 0.5 + 0.5 * Math.sin(a * 3 - time * 1.1 + ring * 0.9);
  const quiet = 0.012 * swell;
  const height = (HALO.rest + quiet + (HALO.peak[ring] - HALO.rest) * level) * halo.radius;
  const r = HALO.radii[ring] * halo.radius;
  // x: along the circle, y: up out of the plate, z: out from the middle (thin).
  const tangent: Vec3 = [halo.right[0] * cos + halo.back[0] * sin, halo.right[1] * cos + halo.back[1] * sin, halo.right[2] * cos + halo.back[2] * sin];
  const radial: Vec3 = [halo.right[0] * sin - halo.back[0] * cos, halo.right[1] * sin - halo.back[1] * cos, halo.right[2] * sin - halo.back[2] * cos];
  out.p[0] = halo.centre[0] + radial[0] * r + halo.normal[0] * (height / 2 + 0.002 * halo.radius);
  out.p[1] = halo.centre[1] + radial[1] * r + halo.normal[1] * (height / 2 + 0.002 * halo.radius);
  out.p[2] = halo.centre[2] + radial[2] * r + halo.normal[2] * (height / 2 + 0.002 * halo.radius);
  out.x = tangent;
  out.y = [halo.normal[0], halo.normal[1], halo.normal[2]];
  out.z = radial;
  placed.width = ((TAU * r) / HALO.per) * HALO.fill;
  placed.height = height;
  placed.thickness = 0.038 * halo.radius;
  placed.glow = Math.min(1, level * 1.15);
}
