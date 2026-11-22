import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARM, DRUM, FIN_COUNT, GROOVE, armAngle, armHead, armReaches, armRest, deckLayout, drumSlot, finPosition, headAt, lineAt, lineFill, pointToProgress, progressToRadius, radiusToProgress } from "../../src/deck/model";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

describe("deck layout", () => {
  for (const [width, height] of [[1280, 720], [1920, 1080], [1024, 600], [2560, 1080], [900, 700]]) {
    it(`keeps the record, its fins and the lyrics apart at ${width}×${height}`, () => {
      const layout = deckLayout({ width, height });
      const { cx, cy, radius } = layout.record;
      assert.ok(cx - radius * 1.45 >= 0, "the plate fits on the left");
      assert.ok(cy - radius >= 0 && cy + radius * 1.1 <= height, "the record fits vertically");
      assert.ok(layout.lyrics.x >= cx + radius * 1.45, "the lyrics start right of the plate");
      assert.ok(layout.lyrics.x + layout.lyrics.width <= width, "the lyrics fit on the right");
      assert.ok(layout.lyrics.width >= 220);
      assert.ok(layout.header.y < layout.lyrics.y);
    });
  }
});

describe("tonearm", () => {
  it("puts the needle exactly at the requested groove, always at the arm's length from the pivot", () => {
    for (let step = 0; step <= 10; step++) {
      const progress = step / 10;
      const radius = progressToRadius(progress);
      assert.ok(armReaches(radius));
      const head = armHead(radius);
      near(Math.hypot(head.x, head.y), radius);
      near(Math.hypot(head.x - ARM.pivot.x, head.y - ARM.pivot.y), ARM.length);
    }
  });

  it("starts at the outer groove and ends at the inner one", () => {
    near(progressToRadius(0), GROOVE.outer);
    near(progressToRadius(1), GROOVE.inner);
    near(radiusToProgress(GROOVE.outer), 0);
    near(radiusToProgress(GROOVE.inner), 1);
    near(radiusToProgress(2), 0);
    near(radiusToProgress(0), 1);
  });

  it("sweeps monotonically towards the centre as the song goes on, on the viewer's side", () => {
    let last = Infinity;
    for (let step = 0; step <= 20; step++) {
      const head = armHead(progressToRadius(step / 20));
      assert.ok(head.x < last + 1e-9, "x only decreases");
      assert.ok(head.y < ARM.pivot.y, "the needle is in front of the pivot");
      last = head.x;
    }
  });

  it("waits outside the record and the angle round-trips", () => {
    const rest = armRest();
    assert.ok(Math.hypot(rest.x, rest.y) > 1.05, "the rest position is off the record");
    near(Math.hypot(rest.x - ARM.pivot.x, rest.y - ARM.pivot.y), ARM.length);
    const head = armHead(0.7);
    const back = headAt(armAngle(head));
    near(back.x, head.x);
    near(back.y, head.y);
  });

  it("reads a dragged pointer as a progress, wherever it is", () => {
    const head = armHead(progressToRadius(0.5));
    near(pointToProgress(head), 0.5, 1e-6);
    // Beyond the needle on the same line from the pivot: still the same groove.
    const further = { x: ARM.pivot.x + (head.x - ARM.pivot.x) * 1.4, y: ARM.pivot.y + (head.y - ARM.pivot.y) * 1.4 };
    near(pointToProgress(further), 0.5, 1e-6);
    assert.equal(pointToProgress({ x: 1.3, y: -0.4 }) >= 0, true);
  });
});

describe("ring of fins", () => {
  it("gives the front the bass, the back the treble, and mirrors both sides", () => {
    near(finPosition(0), 0);
    near(finPosition(FIN_COUNT / 2), 1);
    for (let i = 1; i < FIN_COUNT / 2; i++) near(finPosition(i), finPosition(FIN_COUNT - i));
    for (let i = 1; i < FIN_COUNT / 2; i++) assert.ok(finPosition(i) > finPosition(i - 1));
  });
});

describe("lyrics drum", () => {
  it("puts the line in front at rest in the middle, sharp and fully visible", () => {
    const slot = drumSlot(0);
    near(slot.y, 0);
    near(slot.z, 0);
    near(slot.tilt, 0);
    near(slot.alpha, 1);
    near(slot.blur, 0);
    near(slot.scale, 1);
  });

  it("curves lines away symmetrically, the lines to come below and the sung ones above, fading and blurring with the distance", () => {
    let previous = drumSlot(0);
    for (let d = 1; d <= 5; d++) {
      const below = drumSlot(d);
      const above = drumSlot(-d);
      near(above.y, -below.y);
      near(above.z, below.z);
      near(above.tilt, -below.tilt);
      assert.ok(below.y < 0 && above.y > 0, "lines to come are below, sung ones above");
      // The drum's angle is capped (a line cannot turn past edge-on), so far lines may share a place.
      assert.ok(d > 3 ? below.y <= previous.y : below.y < previous.y, "farther lines sit farther from the middle");
      assert.ok(below.z <= previous.z + 1e-9, "and farther back");
      assert.ok(below.alpha < previous.alpha || below.alpha === 0, "and fainter");
      assert.ok(below.blur > previous.blur, "and blurrier");
      assert.ok(below.alpha >= 0);
      previous = below;
    }
    assert.equal(drumSlot(5).alpha, 0, "the farthest lines are gone");
    assert.ok(Math.abs(drumSlot(40).y) <= DRUM.radius, "never beyond the drum");
  });

  it("is continuous while the drum turns", () => {
    let last = drumSlot(-3);
    for (let d = -3; d <= 3; d += 0.05) {
      const slot = drumSlot(d);
      assert.ok(Math.abs(slot.y - last.y) < 40, "no jumps");
      last = slot;
    }
  });
});

describe("timed lines", () => {
  const lines = [{ t: 1000, text: "第一句" }, { t: 5000, text: "第二句歌词比较长一点点呢" }, { t: 9000, text: "尾声" }];

  it("finds the line that is sung", () => {
    assert.equal(lineAt(lines, 0), -1);
    assert.equal(lineAt(lines, 1000), 0);
    assert.equal(lineAt(lines, 4999), 0);
    assert.equal(lineAt(lines, 5000), 1);
    assert.equal(lineAt(lines, 99999), 2);
    assert.equal(lineAt([], 10), -1);
  });

  it("fills a line from its start to about its end", () => {
    near(lineFill(lines, 0, 1000), 0);
    assert.ok(lineFill(lines, 0, 2000) > 0 && lineFill(lines, 0, 2000) < 1);
    near(lineFill(lines, 0, 5000), 1);
    near(lineFill(lines, 1, 4000), 0);
    near(lineFill(lines, 5, 4000), 0);
    // A short line before a long pause fills at the pace of its length, not of the pause.
    assert.ok(lineFill(lines, 0, 1000 + 1500) >= 0.99);
    assert.ok(lineFill(lines, 2, 9000 + 700) > 0 && lineFill(lines, 2, 9000 + 700) < 1);
  });
});

import { FALLBACK_COLOURS, averageColour, mixRgb, pickColours } from "../../src/deck/palette";

function pixels(colours: [number, number, number, number?][], each = 20): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colours.length * each * 4);
  let at = 0;
  for (const [r, g, b, a = 255] of colours) {
    for (let i = 0; i < each; i++) {
      out[at++] = r;
      out[at++] = g;
      out[at++] = b;
      out[at++] = a;
    }
  }
  return out;
}

describe("cover colours", () => {
  it("prefers a vivid colour over a large grey or white area", () => {
    const picked = pickColours(pixels([[240, 240, 240], [128, 128, 128], [220, 40, 40]], 20));
    assert.ok(picked.vivid[0] > 180 && picked.vivid[1] < 90, `vivid was ${picked.vivid}`);
  });

  it("finds colours of different hues for the second and third", () => {
    const picked = pickColours(pixels([[230, 30, 30], [30, 200, 60], [40, 60, 220]], 30));
    const hues = [picked.vivid, picked.second, picked.third].map(([r, g, b]) => (r > g && r > b ? "r" : g > b ? "g" : "b"));
    assert.equal(new Set(hues).size, 3);
  });

  it("falls back for an empty or transparent picture and averages what is there", () => {
    assert.deepEqual(pickColours(new Uint8ClampedArray(0)).vivid, FALLBACK_COLOURS.vivid);
    assert.deepEqual(pickColours(pixels([[200, 10, 10, 0]])).vivid, FALLBACK_COLOURS.vivid);
    assert.deepEqual(averageColour(pixels([[100, 0, 0], [200, 100, 0]], 10)), [150, 50, 0]);
  });

  it("makes something of a one-colour cover and mixes colours", () => {
    const picked = pickColours(pixels([[20, 120, 220]], 40));
    assert.ok(picked.second && picked.third);
    assert.deepEqual(mixRgb([0, 0, 0], [100, 200, 50], 0.5), [50, 100, 25]);
  });
});
