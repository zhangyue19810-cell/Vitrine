import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROW, rowFrame, trackEdge, trackMesh } from "../../src/row-track";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

describe("download row geometry", () => {
  it("the card at the apex stands upright and faces the viewer", () => {
    const frame = rowFrame(ROW.apex);
    near(frame.point[0], 0);
    near(frame.point[2], 0);
    near(frame.normal[0], 0);
    near(frame.normal[1], 0);
    near(frame.normal[2], 1);
  });

  it("neighbouring slots are one pitch apart along the arc", () => {
    for (let slot = -2; slot < 12; slot++) {
      const a = rowFrame(slot).point;
      const b = rowFrame(slot + 1).point;
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      assert.ok(Math.abs(chord - ROW.pitch) < 0.02, `${slot}: ${chord}`);
    }
  });

  it("the row is concave: cards away from the apex come towards the viewer and turn to face the apex's side", () => {
    const left = rowFrame(ROW.apex - 3);
    const right = rowFrame(ROW.apex + 3);
    assert.ok(left.point[2] > 0 && right.point[2] > 0);
    assert.ok(left.normal[0] > 0, "left cards face right");
    assert.ok(right.normal[0] < 0, "right cards face left");
  });

  it("frames are orthonormal", () => {
    for (let slot = -3; slot < 14; slot += 0.7) {
      const f = rowFrame(slot);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      near(dot(f.tangent, f.tangent), 1);
      near(dot(f.normal, f.normal), 1);
      near(dot(f.tangent, f.normal), 0);
      near(dot(f.width, f.normal), 0);
    }
  });

  it("the track ribbon and its edges are consistent", () => {
    const mesh = trackMesh(-2, 12, 40);
    assert.equal(mesh.positions.length, mesh.rows * 6);
    for (const index of mesh.indices) assert.ok(index < mesh.rows * 2);
    const edge = trackEdge(-2, 12, 1, 40);
    assert.equal(edge.length, 41);
    near(edge[0][0], mesh.positions[0], 1e-5);
    near(edge[40][2], mesh.positions[(mesh.rows - 1) * 6 + 2], 1e-5);
  });
});
