import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newFrame, wrapSigned } from "../../src/mobius-ring";
import { BAND, BandPath, newPlate, plateAt } from "../../src/fin-band";
import { HOLE, ROW_VISIBLE, basisOf, detailPlacement, fovOf, holePlacement, project, ringCamera, rowCamera } from "../../src/stage-layout";
import { rowFrame } from "../../src/row-track";

const ASPECTS = [4 / 3, 16 / 10, 16 / 9, 21 / 9];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("camera presets", () => {
  it("the whole figure eight, plates included, is on screen and keeps to the left of the picture", () => {
    const path = new BandPath();
    const plate = newPlate();
    for (const aspect of ASPECTS) {
      const camera = ringCamera(aspect);
      let left = Infinity;
      let right = -Infinity;
      for (let i = 0; i < 180; i++) {
        plateAt(path, i / 180, 0, plate);
        // The four corners of the plate's face, seen from the camera.
        for (const sx of [-0.5, 0.5]) {
          for (const sy of [-0.5, 0.5]) {
            const corner: [number, number, number] = [
              plate.p[0] + plate.x[0] * sx * BAND.plate.width + plate.y[0] * sy * BAND.plate.height,
              plate.p[1] + plate.x[1] * sx * BAND.plate.width + plate.y[1] * sy * BAND.plate.height,
              plate.p[2] + plate.x[2] * sx * BAND.plate.width + plate.y[2] * sy * BAND.plate.height,
            ];
            const at = project(camera, aspect, corner);
            assert.ok(at.v > 0.04 && at.v < 0.96, `${aspect}: v=${at.v} at lap ${i / 180}`);
            left = Math.min(left, at.u);
            right = Math.max(right, at.u);
          }
        }
      }
      assert.ok(left > 0.005, `${aspect}: the left edge of the ring is at ${left}`);
      assert.ok(right < 0.66, `${aspect}: the right edge of the ring is at ${right}`);
    }
  });

  it("the archive that is read hangs in the opening of the left loop, upright and facing the viewer", () => {
    for (const aspect of ASPECTS) {
      const camera = ringCamera(aspect);
      const placement = holePlacement(camera, aspect);
      const at = project(camera, aspect, placement.position);
      assert.ok(at.u > 0.1 && at.u < 0.32, `${aspect}: u=${at.u}`);
      assert.ok(at.v > 0.42 && at.v < 0.62, `${aspect}: v=${at.v}`);
      const { forward } = basisOf(camera);
      const facing = -dot(placement.normal, forward);
      assert.ok(facing > 0.97, `facing ${facing}`);
      assert.equal(placement.scale, HOLE.scale);
      // Orthonormal axes.
      assert.ok(Math.abs(dot(placement.right, placement.right) - 1) < 1e-9);
      assert.ok(Math.abs(dot(placement.normal, placement.normal) - 1) < 1e-9);
      assert.ok(Math.abs(dot(placement.right, placement.normal)) < 1e-9);
    }
  });

  it("the card in the opening fits inside the left loop (it does not reach the plates beside it)", () => {
    // Half the width of the card on screen, in world units on the camera's right axis, must be less than the free half width of the opening.
    const card = 5 * HOLE.scale;
    assert.ok(card < 2 * (BAND.radius * 0.5) + 2.5, `a card ${card} wide must fit the opening`);
  });

  it("the row view shows slots 1…6 on screen and the first small card right of the pulled-out card", () => {
    for (const aspect of ASPECTS) {
      const camera = rowCamera(aspect);
      const frame = newFrame();
      for (let slot = ROW_VISIBLE.first; slot <= ROW_VISIBLE.last; slot++) {
        rowFrame(slot, frame);
        const at = project(camera, aspect, frame.point);
        assert.ok(at.u > 0.3 && at.u < 1.02 && at.v > 0.05 && at.v < 0.95, `${aspect} slot ${slot}: (${at.u}, ${at.v})`);
      }
      rowFrame(1, frame);
      assert.ok(project(camera, aspect, frame.point).u > 0.4);
    }
  });

  it("the lens stays long (narrow field of view) so the cards look like the old shelf, not a fisheye", () => {
    for (const aspect of ASPECTS) assert.ok(fovOf(ringCamera(aspect)) * (180 / Math.PI) < 14, `ring ${aspect}`);
    assert.ok(fovOf(rowCamera(16 / 9)) * (180 / Math.PI) < 14);
  });

  it("the pulled-out card hangs on the left of the picture, faces the camera and does not touch the row", () => {
    for (const aspect of ASPECTS) {
      const camera = rowCamera(aspect);
      const placement = detailPlacement(camera, aspect);
      const at = project(camera, aspect, placement.position);
      assert.ok(at.u > 0.15 && at.u < 0.32, `u=${at.u}`);
      assert.ok(at.v > 0.35 && at.v < 0.6, `v=${at.v}`);
      const { forward } = basisOf(camera);
      const facing = -(placement.normal[0] * forward[0] + placement.normal[1] * forward[1] + placement.normal[2] * forward[2]);
      assert.ok(facing > 0.9, `facing ${facing}`);
      // Its right edge is left of slot 1.
      const edge = [placement.position[0] + placement.right[0] * 2.5 * placement.scale, placement.position[1] + placement.right[1] * 2.5 * placement.scale, placement.position[2] + placement.right[2] * 2.5 * placement.scale] as [number, number, number];
      const frame = rowFrame(1, newFrame());
      assert.ok(project(camera, aspect, edge).u < project(camera, aspect, frame.point).u - 0.02);
    }
  });

  it("the placement axes are orthonormal", () => {
    const placement = detailPlacement(rowCamera(16 / 9), 16 / 9);
    assert.ok(Math.abs(dot(placement.right, placement.right) - 1) < 1e-9);
    assert.ok(Math.abs(dot(placement.normal, placement.normal) - 1) < 1e-9);
    assert.ok(Math.abs(dot(placement.right, placement.normal)) < 1e-9);
    assert.ok(Math.abs(dot(placement.up, placement.right)) < 1e-9 || Math.abs(dot(placement.up, placement.right)) < 0.35);
  });
});

describe("wrapSigned", () => {
  it("folds a position into the shorter way round", () => {
    assert.equal(wrapSigned(4.5, 9), 4.5);
    assert.equal(wrapSigned(5, 9), -4);
    assert.equal(wrapSigned(-5, 9), 4);
    assert.equal(wrapSigned(9, 9), 0);
    assert.equal(wrapSigned(1, 0), 0);
  });
});
