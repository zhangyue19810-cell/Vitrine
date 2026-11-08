import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TIMING, delayOf, enterOffset, exitOffset, identity, seedOf, transitionLength, type Offset, type Style } from "../../src/choreography";

const STYLES: Style[] = ["spiral", "scatter", "gather"];
const distance = (o: Offset) => Math.hypot(o.x, o.y, o.z);
const finite = (o: Offset) => Object.values(o).every((value) => Number.isFinite(value));

describe("view transitions", () => {
  it("seeds are reproducible and stay within [-1, 1]", () => {
    assert.deepEqual(seedOf(7), seedOf(7));
    assert.notDeepEqual(seedOf(7), seedOf(8));
    for (let n = -50; n < 500; n++) for (const value of seedOf(n)) assert.ok(value >= -1 && value <= 1, `${n}: ${value}`);
  });

  it("seeds are spread out (not all the same sign, not clustered)", () => {
    const first = Array.from({ length: 400 }, (_, n) => seedOf(n)[0]);
    const mean = first.reduce((a, b) => a + b, 0) / first.length;
    assert.ok(Math.abs(mean) < 0.15, `mean ${mean}`);
    assert.ok(first.filter((v) => v > 0.5).length > 40 && first.filter((v) => v < -0.5).length > 40);
  });

  for (const style of STYLES) {
    it(`${style}: an arriving card ends exactly at rest and never produces NaN`, () => {
      for (let n = 0; n < 60; n++) {
        const seed = seedOf(n);
        const end = enterOffset(style, 1, seed);
        assert.deepEqual(end, identity());
        for (let t = 0; t <= 1.0001; t += 0.01) assert.ok(finite(enterOffset(style, t, seed)), `${n}@${t}`);
      }
    });

    it(`${style}: a leaving card starts exactly at rest, ends far away, and never produces NaN`, () => {
      for (let n = 0; n < 60; n++) {
        const seed = seedOf(n);
        assert.deepEqual(exitOffset(style, 0, seed, 1), identity());
        const end = exitOffset(style, 1, seed, n % 2 ? -1 : 1);
        assert.ok(distance(end) > 12, `${style} card ${n} only moved ${distance(end)}`);
        for (let t = 0; t <= 1.0001; t += 0.01) assert.ok(finite(exitOffset(style, t, seed, 0)), `${n}@${t}`);
      }
    });

    it(`${style}: arriving cards approach their place (gather overshoots a little, then settles)`, () => {
      // easeOutBack first reaches its target at t ≈ 0.45 and then swings past it by under 10 %.
      const limit = style === "gather" ? 0.45 : 0.8;
      for (let n = 0; n < 40; n++) {
        const seed = seedOf(n);
        const start = distance(enterOffset(style, 0, seed));
        let previous = Infinity;
        for (let t = 0; t <= 1; t += 0.02) {
          const d = distance(enterOffset(style, t, seed));
          if (style === "gather" && t > limit) assert.ok(d <= 0.12 * start + 1e-6, `${style} card ${n} overshoots too far at t=${t}`);
        }
        for (let t = 0; t <= limit; t += 0.02) {
          const d = distance(enterOffset(style, t, seed));
          assert.ok(d <= previous + 1e-6, `${style} card ${n} moved away at t=${t}`);
          previous = d;
        }
      }
    });

    it(`${style}: leaving cards move away monotonically`, () => {
      for (let n = 0; n < 40; n++) {
        const seed = seedOf(n);
        let previous = -Infinity;
        for (let t = 0.1; t <= 1.0001; t += 0.05) {
          const d = distance(exitOffset(style, t, seed, 1));
          assert.ok(d >= previous - 2.6, `${style} card ${n} came back at t=${t}`); // scatter has a small vertical swing
          previous = Math.max(previous, d);
        }
      }
    });
  }

  it("spiral cards come from below, and leave downwards", () => {
    for (let n = 0; n < 30; n++) {
      const seed = seedOf(n);
      assert.ok(enterOffset("spiral", 0, seed).y < -20);
      assert.ok(exitOffset("spiral", 1, seed).y < -20);
    }
  });

  it("scatter pulls the two halves apart: left of centre goes left, right goes right", () => {
    for (let n = 0; n < 30; n++) {
      const seed = seedOf(n);
      assert.ok(exitOffset("scatter", 1, seed, -1).x < -15);
      assert.ok(exitOffset("scatter", 1, seed, 1).x > 15);
    }
  });

  it("scatter is irregular: cards do not all go the same distance", () => {
    const xs = Array.from({ length: 30 }, (_, n) => exitOffset("scatter", 0.7, seedOf(n), 1).x);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 4, "all cards moved the same amount");
    const ys = Array.from({ length: 30 }, (_, n) => exitOffset("scatter", 0.7, seedOf(n), 1).y);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 3);
  });

  it("gather cards start in different directions all around", () => {
    const starts = Array.from({ length: 80 }, (_, n) => enterOffset("gather", 0, seedOf(n)));
    assert.ok(starts.some((o) => o.x > 10) && starts.some((o) => o.x < -10));
    assert.ok(starts.some((o) => o.y > 10) && starts.some((o) => o.y < -10));
    assert.ok(starts.some((o) => o.z > 5) && starts.some((o) => o.z < -5));
  });

  it("delays grow with the card order and stay within the transition length", () => {
    for (const style of STYLES) {
      const delays = Array.from({ length: 24 }, (_, i) => delayOf(style, i, seedOf(i)));
      assert.ok(delays.every((d) => d >= 0));
      assert.ok(delays[23] > delays[0] - TIMING[style].jitter);
      assert.ok(Math.max(...delays) + TIMING[style].enter <= transitionLength(style, 24, "enter") + 1e-9);
      assert.ok(Math.max(...delays) + TIMING[style].exit <= transitionLength(style, 24, "exit") + 1e-9 + (TIMING[style].enter - TIMING[style].exit));
    }
  });

  it("whole transitions stay short enough to feel responsive", () => {
    for (const style of STYLES) {
      assert.ok(transitionLength(style, 12, "enter") < 3.2, `${style} enter ${transitionLength(style, 12, "enter")}`);
      assert.ok(transitionLength(style, 12, "exit") < 2.4, `${style} exit ${transitionLength(style, 12, "exit")}`);
    }
  });
});

import { FLIGHT, flightDelay, flightEase, flightLength, flightOffset } from "../../src/choreography";

describe("cards that fly from one picture into the next", () => {
  it("the swirl is zero at both ends and the card has turned a whole number of times", () => {
    for (let n = 0; n < 60; n++) {
      const seed = seedOf(n);
      const start = flightOffset(0, seed);
      const end = flightOffset(1, seed);
      for (const f of [start, end]) {
        assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.y) < 1e-9 && Math.abs(f.z) < 1e-9);
        assert.ok(Math.abs(f.pop - 1) < 1e-9);
      }
      assert.ok(Math.abs(start.spin) < 1e-9);
      assert.ok(Math.abs(Math.abs(end.spin) - 2 * Math.PI) < 1e-9);
    }
  });

  it("the turn passes half-way (the card faces away and its face can be swapped) in the middle of the flight", () => {
    for (let n = 0; n < 40; n++) {
      const seed = seedOf(n);
      assert.ok(Math.abs(flightOffset(0.5, seed).turn - 0.5) < 1e-9);
      assert.ok(Math.abs(Math.abs(flightOffset(0.5, seed).spin) - Math.PI) < 1e-9);
    }
  });

  it("stays finite and bounded, dips below the straight path and never wanders far", () => {
    for (let n = 0; n < 80; n++) {
      const seed = seedOf(n);
      let lowest = 0;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const f = flightOffset(t, seed);
        for (const value of [f.x, f.y, f.z, f.spin, f.pop, f.turn]) assert.ok(Number.isFinite(value));
        assert.ok(Math.hypot(f.x, f.y, f.z) < 11, `${n}@${t}`);
        lowest = Math.min(lowest, f.y);
      }
      assert.ok(lowest < -3, `card ${n} never dipped (${lowest})`);
    }
  });

  it("the easing is monotonic from 0 to 1", () => {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const value = flightEase(t);
      assert.ok(value >= previous - 1e-12);
      previous = value;
    }
    assert.equal(flightEase(0), 0);
    assert.ok(Math.abs(flightEase(1) - 1) < 1e-12);
  });

  it("the whole regrouping is short enough to feel responsive even for many cards", () => {
    assert.ok(flightLength(12) < 2.5, `${flightLength(12)}`);
    assert.ok(flightLength(40) < 3.8, `${flightLength(40)}`);
    for (let n = 0; n < 30; n++) assert.ok(flightDelay(n, seedOf(n)) <= flightLength(n + 1) - FLIGHT.duration + 1e-9);
  });
});
