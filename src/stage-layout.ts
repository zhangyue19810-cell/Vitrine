import { newFrame, type Vec3 } from "./mobius-ring";
import { BAND, holeCentre } from "./fin-band";
import { rowFrame } from "./row-track";

/**
 * Where the camera stands for each view, and where the pulled-out card goes. Everything is expressed through screen
 * anchors ("this point should appear 30 % from the left and 52 % from the top") so the composition survives any window
 * shape; the arithmetic is pure and the tests project real points to check that nothing falls off the screen.
 */

export interface CameraPreset {
  /** The point the camera looks at. */
  aim: Vec3;
  /** Unit vector from the aim towards the camera. */
  dir: Vec3;
  /** Distance from the aim to the camera (the lens is long, so this mostly sets the perspective strength). */
  distance: number;
  /** World height that the picture shows at the aim. */
  span: number;
}

export interface Basis {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const deg = (value: number) => (value * Math.PI) / 180;

/** Direction from the aim to a camera at `azimuth` (negative: to the left of the front) and `elevation` degrees. */
export function viewDirection(azimuth: number, elevation: number): Vec3 {
  const az = deg(azimuth);
  const el = deg(elevation);
  return norm([Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]);
}

/** Camera axes for a preset (the camera looks along −dir). */
export function basisOf(preset: Pick<CameraPreset, "dir">): Basis {
  const forward: Vec3 = [-preset.dir[0], -preset.dir[1], -preset.dir[2]];
  const right = norm(cross(forward, [0, 1, 0]));
  const up = norm(cross(right, forward));
  return { right, up, forward };
}

/** Vertical field of view (radians) that shows `span` world units at `distance`. */
export const fovOf = (preset: Pick<CameraPreset, "span" | "distance">) => 2 * Math.atan(preset.span / (2 * preset.distance));

/** The aim that makes `point` appear at (`u` from the left, `v` from the top) of a picture `span` high and `aspect` wide/high. */
export function anchoredAim(point: Vec3, u: number, v: number, dir: Vec3, span: number, aspect: number): Vec3 {
  const { right, up } = basisOf({ dir });
  const width = span * aspect;
  const shiftX = (0.5 - u) * width;
  const shiftY = (v - 0.5) * span;
  return [point[0] + right[0] * shiftX + up[0] * shiftY, point[1] + right[1] * shiftX + up[1] * shiftY, point[2] + right[2] * shiftX + up[2] * shiftY];
}

/** Screen position (0…1 from the left / from the top) of a world point seen through `preset`. Perspective is included. */
export function project(preset: CameraPreset, aspect: number, point: Vec3): { u: number; v: number; depth: number } {
  const { right, up, forward } = basisOf(preset);
  const camera: Vec3 = [preset.aim[0] + preset.dir[0] * preset.distance, preset.aim[1] + preset.dir[1] * preset.distance, preset.aim[2] + preset.dir[2] * preset.distance];
  const rel: Vec3 = [point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]];
  const depth = dot(rel, forward);
  const half = Math.tan(fovOf(preset) / 2);
  const x = dot(rel, right) / (depth * half * aspect);
  const y = dot(rel, up) / (depth * half);
  return { u: 0.5 + x / 2, v: 0.5 - y / 2, depth };
}

export const VIEW = {
  /** The ring is seen almost head-on, a little from above and from the left; the row from the upper left. */
  ring: { azimuth: -10, elevation: 13 },
  row: { azimuth: -46, elevation: 25 },
};

/** A long lens: the farther the camera, the flatter the picture. The far plane is 300, which leaves the ring's depth room at 240. */
const lens = (span: number) => clamp(span * 5, 100, 240);

/** Where on the picture the figure eight goes: its middle at (`u`, `v`), the whole of it within `share` of the width. */
export const RING_VIEW = { u: 0.285, v: 0.5, share: 0.5 };

/** The home view: the whole Möbius ring on the left of the picture, where the HUD leaves room. */
export function ringCamera(aspect: number): CameraPreset {
  const dir = viewDirection(VIEW.ring.azimuth, VIEW.ring.elevation);
  // Wide enough for the figure eight and its plates, tall enough that its lobes are not cut off.
  const width = 2 * (BAND.radius + BAND.plate.width * 0.5 + 1);
  const height = 2 * (BAND.radius * BAND.squash * 0.36 + BAND.plate.height * 0.6) + BAND.depth * 0.5;
  const span = clamp(Math.max(width / (RING_VIEW.share * aspect), height / 0.72), 24, 64);
  const aim = anchoredAim([0, 0, 0], RING_VIEW.u, RING_VIEW.v, dir, span, aspect);
  return { aim, dir, distance: lens(span), span };
}

/** The download view: one row on a track, seen from the upper left; the selected card is pulled out to the left. */
export function rowCamera(aspect: number): CameraPreset {
  const dir = viewDirection(VIEW.row.azimuth, VIEW.row.elevation);
  // The picture is 25 high on a wide window and grows on a narrow one, so slots 1…6 always fit the width.
  const span = Math.max(25, 44.5 / aspect);
  // The first small card (slot 1) starts right of the pulled-out card; slots 1…6 fill the rest of the picture.
  const frame = rowFrame(1, newFrame());
  const aim = anchoredAim([frame.point[0], frame.point[1], frame.point[2]], 0.5, 0.6, dir, span, aspect);
  return { aim, dir, distance: lens(span), span };
}

export interface DetailPlacement {
  position: Vec3;
  /** Card axes in the world: x along the card's width, y up, z the way the face points (towards the camera). */
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  /** Scale of the card (a cassette is 3.7 high). */
  scale: number;
}

/**
 * Where the pulled-out card hangs: a fixed place on the screen (left, a little above the middle), facing the camera with a
 * slight turn towards the middle, sized to a fixed share of the picture's height.
 */
export function detailPlacement(preset: CameraPreset, aspect: number, share = 0.46, turn = 0.2): DetailPlacement {
  const { right, up, forward } = basisOf(preset);
  const width = preset.span * aspect;
  const centre: Vec3 = [
    preset.aim[0] + right[0] * (-0.255 * width) + up[0] * (0.035 * preset.span),
    preset.aim[1] + right[1] * (-0.255 * width) + up[1] * (0.035 * preset.span),
    preset.aim[2] + right[2] * (-0.255 * width) + up[2] * (0.035 * preset.span),
  ];
  // Pull it towards the camera a little so it never intersects the row behind it.
  const toward: Vec3 = [-forward[0], -forward[1], -forward[2]];
  const position: Vec3 = [centre[0] + toward[0] * 6, centre[1] + toward[1] * 6, centre[2] + toward[2] * 6];
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  // Turn about the camera's up axis so the card's face looks a little towards the middle of the picture.
  const cardRight: Vec3 = [right[0] * c - toward[0] * s, right[1] * c - toward[1] * s, right[2] * c - toward[2] * s];
  const cardNormal: Vec3 = [toward[0] * c + right[0] * s, toward[1] * c + right[1] * s, toward[2] * c + right[2] * s];
  // The card is 6 units nearer the camera: shrink so that its apparent size stays the same.
  const nearer = (preset.distance - 6) / preset.distance;
  return { position, right: cardRight, up, normal: cardNormal, scale: (share * preset.span * nearer) / 3.7 };
}

/** The archive that is being read hangs in the opening of the left loop, facing the viewer, a little larger than on the band. */
export const HOLE = { scale: 2.1, lift: 3.4, turn: 0.1 };

export function holePlacement(preset: CameraPreset, aspect: number): DetailPlacement {
  void aspect;
  const { right, up, forward } = basisOf(preset);
  const toward: Vec3 = [-forward[0], -forward[1], -forward[2]];
  const centre = holeCentre();
  const position: Vec3 = [centre[0] + toward[0] * HOLE.lift, centre[1] + toward[1] * HOLE.lift, centre[2] + toward[2] * HOLE.lift];
  const c = Math.cos(HOLE.turn);
  const s = Math.sin(HOLE.turn);
  const cardRight: Vec3 = [right[0] * c - toward[0] * s, right[1] * c - toward[1] * s, right[2] * c - toward[2] * s];
  const cardNormal: Vec3 = [toward[0] * c + right[0] * s, toward[1] * c + right[1] * s, toward[2] * c + right[2] * s];
  return { position, right: cardRight, up, normal: cardNormal, scale: HOLE.scale };
}

/** The slots that must be on the screen in the row view (the card at slot 0 is pulled out). */
export const ROW_VISIBLE = { first: 1, last: 6 };
