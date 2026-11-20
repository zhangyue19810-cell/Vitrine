import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capsuleSpringStep } from "../../src/app/capsule-spring";

describe("capsule spring", () => {
  it("overshoots once and settles without staying in motion", () => {
    let value = 0;
    let velocity = 0;
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      const next = capsuleSpringStep(value, velocity, 1, 0.26, 0.72);
      value = next.value;
      velocity = next.velocity;
      peak = Math.max(peak, value);
    }
    assert.ok(peak > 1.02, "the capsule should have a visible elastic overshoot");
    for (let i = 0; i < 120; i++) {
      const next = capsuleSpringStep(value, velocity, 1, 0.26, 0.72);
      value = next.value;
      velocity = next.velocity;
    }
    assert.ok(Math.abs(value - 1) < 0.02, "it should settle at the target");
    assert.ok(Math.abs(velocity) < 0.02, "the spring should come to rest");
  });
});
