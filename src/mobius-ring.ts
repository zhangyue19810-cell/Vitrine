/**
 * Frames shared by the stage: the middle of a card and its axes in the world.
 *
 * The Möbius ring itself (the figure-eight band of plates) lives in `fin-band.ts`. What is left here is the small frame
 * type that the download row (`row-track.ts`) and the stage use, and `wrapSigned`.
 */

export type Vec3 = [number, number, number];

export interface RingFrame {
  /** Point of the centre line (the middle of the card). */
  point: Vec3;
  /** Card x axis: along the row. */
  tangent: Vec3;
  /** Card y axis: across the row; "up" for an upright card. */
  width: Vec3;
  /** Card z axis: the way the card faces. */
  normal: Vec3;
  /** Position along the curve in radians. */
  angle: number;
  /** Roll of the card about the curve, in radians. */
  roll: number;
}

export const newFrame = (): RingFrame => ({
  point: [0, 0, 0],
  tangent: [1, 0, 0],
  width: [0, 1, 0],
  normal: [0, 0, 1],
  angle: 0,
  roll: 0,
});

/** `value` folded into (−count/2, count/2]: the signed distance to the front along the shorter way round. */
export function wrapSigned(value: number, count: number): number {
  if (count <= 0) return 0;
  const half = count / 2;
  let wrapped = ((value % count) + count) % count;
  if (wrapped > half) wrapped -= count;
  return wrapped;
}
