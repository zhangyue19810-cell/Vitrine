import { railScale, type Viewport } from "../rail/model";

/**
 * The deck's plain numbers: where things stand on the page, where the tonearm's needle is for a given moment of a song,
 * which frequency band a fin of the ring listens to, and how the lyrics are laid out on their drum. No three.js and no
 * DOM in here, so all of it is tested on its own (`core/test/deck-model.test.ts`).
 *
 * Lengths of the record's own plane are in record radii (the record has radius 1, y points to the back of the turntable);
 * lengths on the screen are CSS pixels, top-left origin.
 */

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

export interface Vec2 {
  x: number;
  y: number;
}

// ───────────────────────────────────────────── the page ─────────────────────────────────────────────

export interface DeckLayout {
  scale: number;
  /** The record's centre on the screen and its radius in px. The turntable plate under it reaches 1.45 radii. */
  record: { cx: number; cy: number; radius: number };
  /** The column of lyrics: the drum is centred on it. */
  lyrics: { x: number; y: number; width: number; height: number };
  /** Where the title block starts (above the lyrics). */
  header: { x: number; y: number; width: number };
}

/** How far the turntable leans back from facing the viewer (radians): enough to read it as an object, little enough to read the cover. */
export const DECK_TILT = (40 * Math.PI) / 180;

export function deckLayout(view: Viewport, scale = railScale(view)): DeckLayout {
  const radius = Math.min(view.height * 0.235, view.width * 0.15);
  const cx = Math.max(radius * 1.75, view.width * 0.29);
  const cy = view.height * 0.55;
  const x = Math.max(cx + radius * 1.95, view.width * 0.55);
  const right = 34 * scale;
  const width = Math.max(220, view.width - right - x);
  return {
    scale,
    record: { cx, cy, radius },
    lyrics: { x, y: view.height * 0.3, width, height: view.height * 0.5 },
    header: { x, y: view.height * 0.15, width },
  };
}

// ───────────────────────────────────────────── the tonearm ─────────────────────────────────────────────

/** Where on the record the first and the last groove are, as fractions of its radius. */
export const GROOVE = { outer: 0.93, inner: 0.4 } as const;

export const progressToRadius = (progress: number) => GROOVE.outer + (GROOVE.inner - GROOVE.outer) * clamp01(progress);
export const radiusToProgress = (radius: number) => clamp01((GROOVE.outer - radius) / (GROOVE.outer - GROOVE.inner));

export interface Arm {
  /** The pivot, in record radii. */
  pivot: Vec2;
  /** Pivot to needle. */
  length: number;
}

/** The arm stands at the back right of the plate; its length lets the needle reach every groove. */
export const ARM: Arm = { pivot: { x: 1.2, y: 0.9 }, length: 1.24 };

/** Whether the needle can be at distance `radius` from the record's centre with this arm. */
export function armReaches(radius: number, arm: Arm = ARM): boolean {
  const d = Math.hypot(arm.pivot.x, arm.pivot.y);
  return radius >= Math.abs(arm.length - d) - 1e-9 && radius <= arm.length + d + 1e-9;
}

/**
 * The needle's position when it is `radius` record radii from the centre: the intersection of that circle with the circle the
 * arm sweeps. Of the two intersections the one on the viewer's side (smaller y) is taken, like on a real turntable.
 */
export function armHead(radius: number, arm: Arm = ARM): Vec2 {
  const { x: px, y: py } = arm.pivot;
  const d = Math.hypot(px, py);
  const a = (radius * radius - arm.length * arm.length + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, radius * radius - a * a));
  const mx = (a / d) * px;
  const my = (a / d) * py;
  const ox = (-py / d) * h;
  const oy = (px / d) * h;
  const first = { x: mx + ox, y: my + oy };
  const second = { x: mx - ox, y: my - oy };
  return first.y <= second.y ? first : second;
}

/** Where the needle waits when nothing plays: just outside the record, in front of the pivot. */
export function armRest(arm: Arm = ARM): Vec2 {
  return headAt(-Math.PI / 2 - 0.05, arm);
}

/** The direction of the arm, pivot to needle, in radians (0 = along +x, counter-clockwise in the record's plane). */
export function armAngle(head: Vec2, arm: Arm = ARM): number {
  return Math.atan2(head.y - arm.pivot.y, head.x - arm.pivot.x);
}

/** The needle position for the arm at `angle` (what a drag of the arm does). */
export function headAt(angle: number, arm: Arm = ARM): Vec2 {
  return { x: arm.pivot.x + Math.cos(angle) * arm.length, y: arm.pivot.y + Math.sin(angle) * arm.length };
}

/** How far a needle that follows a pointer at `point` (record plane, in radii) is from the centre, as the song's progress. */
export function pointToProgress(point: Vec2, arm: Arm = ARM): number {
  // The needle only moves on the arm's circle: find the point of it nearest to the pointer, then read its groove.
  const dx = point.x - arm.pivot.x;
  const dy = point.y - arm.pivot.y;
  const length = Math.hypot(dx, dy) || 1;
  const head = { x: arm.pivot.x + (dx / length) * arm.length, y: arm.pivot.y + (dy / length) * arm.length };
  return radiusToProgress(Math.hypot(head.x, head.y));
}

// ───────────────────────────────────────────── the ring of fins ─────────────────────────────────────────────

/** How many fins stand around the record. */
export const FIN_COUNT = 72;

/**
 * Which part of the spectrum (0 … 1 across the bands) fin `i` of `count` listens to: the front of the ring (towards the
 * viewer) gets the bass, the back the treble, and both sides mirror each other, so the picture stays symmetrical.
 */
export function finPosition(i: number, count: number = FIN_COUNT): number {
  const t = ((i % count) + count) % count / count;
  return Math.min(t, 1 - t) * 2;
}

/** The angle of fin `i` around the record, counter-clockwise from the front (0 = towards the viewer). */
export const finAngle = (i: number, count: number = FIN_COUNT) => (i / count) * Math.PI * 2;

// ───────────────────────────────────────────── the lyrics ─────────────────────────────────────────────

/** The lyrics hang on a drum that turns about a horizontal axis: the line in front is read, the others curve away. */
export interface DrumShape {
  /** Radius of the drum in px at scale 1. */
  radius: number;
  /** Angle between neighbouring lines (radians). */
  step: number;
  /** Extra room around the line in front (in lines), so that the one being sung stands free. */
  gap: number;
}

export const DRUM: DrumShape = { radius: 300, step: 0.32, gap: 0.45 };

export interface DrumSlot {
  /** Height above the middle (negative: below it) and depth behind the front (≤ 0), px at scale 1. */
  y: number;
  z: number;
  /** Angle of the line's plane about the x axis (radians): lines above the middle lean their top back, lines below lean their bottom back. */
  tilt: number;
  alpha: number;
  /** How blurred the line is (mip-map bias): lines far from the front are out of focus. */
  blur: number;
  scale: number;
}

/** Place the line that is `d` lines away from the one in front: the lines still to come (d > 0) lie below it, the ones already sung (d < 0) above. */
export function drumSlot(d: number, shape: DrumShape = DRUM): DrumSlot {
  const away = Math.abs(d);
  const widened = d + shape.gap * Math.tanh(d * 2.5);
  const angle = Math.max(-1.35, Math.min(1.35, widened * shape.step));
  // Far lines fade out completely before they reach the edge of the drum, so that nothing hangs about the title block above it.
  const window = 1 - smooth((away - 2.7) / 1.5);
  return {
    y: -shape.radius * Math.sin(angle),
    z: shape.radius * (Math.cos(angle) - 1),
    tilt: angle,
    alpha: Math.max(0, window / (1 + 0.9 * Math.pow(Math.max(0, away - 0.15), 1.25))),
    blur: Math.min(3.4, away < 0.2 ? 0 : 0.5 * Math.pow(away, 1.2) + 0.2),
    scale: 1 - 0.1 * Math.min(1, away),
  };
}

const smooth = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

export interface TimedLine {
  t: number;
  text: string;
}

/** The index of the line that is sung at `ms` (−1 before the first). */
export function lineAt(lines: readonly TimedLine[], ms: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].t <= ms) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/**
 * How much of line `index` has been sung at `ms` (0 … 1). Lines carry only their start, so the pace is guessed: about a third
 * of a second per character, but never longer than the time until the next line.
 */
export function lineFill(lines: readonly TimedLine[], index: number, ms: number): number {
  const line = lines[index];
  if (!line) return 0;
  const next = lines[index + 1]?.t ?? line.t + 5000;
  const span = Math.max(300, Math.min(next - line.t, Math.max(1500, [...line.text].length * 330)));
  return clamp01((ms - line.t) / (span * 0.94));
}
