import { newFrame, type RingFrame, type Vec3 } from "./mobius-ring";

/**
 * The download view's single row of archives. The cards follow a shallow concave arc (its centre lies in front of the
 * row, so the ends curve towards the viewer, like a curved screen) and the camera looks at it from the upper left.
 * Pure geometry, shared by the scene and its tests. Slot 0 is the selected card (it is pulled out to the left by the
 * stage); slots 1, 2, … continue to the right.
 */
export const ROW = {
  /** Radius of the arc the cards stand on. */
  radius: 46,
  /** Space one card takes along the arc. */
  pitch: 6.3,
  /** The slot at the arc's apex (angle 0). */
  apex: 3.4,
  /** Half width of the glass track under the cards, across the arc. */
  halfWidth: 2.7,
  /** Cards beyond these slots are off the track and are hidden. */
  firstSlot: -2.6,
  lastSlot: 9,
};

/** Frame of the card in `slot`, same conventions as the ring: x along the row, y up, z the way the card faces. */
export function rowFrame(slot: number, out: RingFrame = newFrame()): RingFrame {
  const angle = ((slot - ROW.apex) * ROW.pitch) / ROW.radius;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  out.point[0] = ROW.radius * sin;
  out.point[1] = 0;
  out.point[2] = ROW.radius * (1 - cos);
  out.tangent[0] = cos;
  out.tangent[1] = 0;
  out.tangent[2] = sin;
  out.width[0] = 0;
  out.width[1] = 1;
  out.width[2] = 0;
  out.normal[0] = -sin;
  out.normal[1] = 0;
  out.normal[2] = cos;
  out.angle = angle;
  out.roll = 0;
  return out;
}

/** Corner points of a flat ribbon under the row between two slots: pairs (inner, outer) per row, as in a triangle strip. */
export function trackMesh(fromSlot: number, toSlot: number, segments = 64, drop = 1.95, halfWidth: number = ROW.halfWidth) {
  const rows = Math.max(2, Math.floor(segments)) + 1;
  const positions = new Float32Array(rows * 2 * 3);
  const across = new Float32Array(rows * 2);
  const frame = newFrame();
  for (let row = 0; row < rows; row++) {
    rowFrame(fromSlot + ((toSlot - fromSlot) * row) / (rows - 1), frame);
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const at = (row * 2 + side) * 3;
      positions[at] = frame.point[0] + frame.normal[0] * halfWidth * sign;
      positions[at + 1] = frame.point[1] - drop;
      positions[at + 2] = frame.point[2] + frame.normal[2] * halfWidth * sign;
      across[row * 2 + side] = sign;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < rows - 1; row++) {
    const a = row * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return { positions, across, indices: new Uint32Array(indices), rows };
}

/** Points along one edge of the track (for a thin line). */
export function trackEdge(fromSlot: number, toSlot: number, side: 1 | -1, segments = 64, drop = 1.95, halfWidth: number = ROW.halfWidth): Vec3[] {
  const frame = newFrame();
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    rowFrame(fromSlot + ((toSlot - fromSlot) * i) / segments, frame);
    points.push([frame.point[0] + frame.normal[0] * halfWidth * side, frame.point[1] - drop, frame.point[2] + frame.normal[2] * halfWidth * side]);
  }
  return points;
}
