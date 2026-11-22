import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeQr, QR_MAX_BYTES } from "../../src/app/music/qr";
import {
  DISC_RADIUS,
  DISC_TOP,
  EDGE,
  contains,
  discGeometry,
  discReserve,
  discRowMargin,
  discTurn,
  discZone,
  hitPlate,
  layoutGroups,
  railScale,
  turnDelta,
  type PlateGroup,
  type PlateSpec,
} from "../../src/rail/model";

const tab = (id: string, width = 90, extra: Partial<PlateSpec> = {}): PlateSpec => ({ id, kind: "tab", label: id, width, ...extra });
const VIEW = { width: 1440, height: 810 };

describe("rail layout", () => {
  it("the scale is 1 at 1440×810, smaller on small windows, capped on large ones", () => {
    assert.equal(railScale(VIEW), 1);
    assert.ok(railScale({ width: 800, height: 600 }) < 0.8);
    assert.equal(railScale({ width: 300, height: 300 }), 0.72);
    assert.equal(railScale({ width: 3840, height: 2160 }), 1.25);
  });

  it("a bottom row is centred, its plates sit side by side on one line above the bottom edge", () => {
    const groups: PlateGroup[] = [{ id: "g", dock: "bottom", gap: 10, plates: [tab("a", 100), tab("b", 100), tab("c", 100)] }];
    const rects = layoutGroups(groups, VIEW);
    const a = rects.get("a")!;
    const c = rects.get("c")!;
    assert.equal(a.x + (c.x + c.w - a.x) / 2, VIEW.width / 2);
    assert.equal(a.y, c.y);
    assert.equal(a.y + a.h, VIEW.height - EDGE);
    assert.equal(rects.get("b")!.x, a.x + a.w + 10);
  });

  it("left and right docks start at the corner, 'lift' raises a plate, a column is centred vertically", () => {
    const groups: PlateGroup[] = [
      { id: "l", dock: "bottom-left", plates: [tab("l1", 80), tab("l2", 80, { lift: 12 })], gap: 8 },
      { id: "r", dock: "bottom-right", plates: [tab("r1", 80), tab("r2", 80)], gap: 8 },
      { id: "c", dock: "right", plates: [tab("c1", 60), tab("c2", 60)], gap: 8 },
    ];
    const rects = layoutGroups(groups, VIEW);
    assert.equal(rects.get("l1")!.x, EDGE);
    assert.equal(rects.get("l2")!.y, rects.get("l1")!.y - 12);
    assert.equal(rects.get("r2")!.x + rects.get("r2")!.w, VIEW.width - EDGE);
    const column = [rects.get("c1")!, rects.get("c2")!];
    assert.equal(column[0].x, column[1].x);
    assert.ok(Math.abs(column[0].y + (column[1].y + column[1].h - column[0].y) / 2 - VIEW.height / 2) < 1);
  });

  it("rows that share the bottom edge shrink together when they do not fit, and never overlap", () => {
    const groups: PlateGroup[] = [
      { id: "l", dock: "bottom-left", offset: 200, plates: [tab("l1", 260), tab("l2", 60)], gap: 8 },
      { id: "r", dock: "bottom-right", plates: [tab("r1", 120), tab("r2", 120), tab("r3", 120), tab("r4", 120), tab("r5", 120)], gap: 8 },
    ];
    for (const width of [1440, 1100, 820, 640]) {
      const view = { width, height: 600 };
      const rects = layoutGroups(groups, view);
      const leftEdge = Math.max(...["l1", "l2"].map((id) => rects.get(id)!.x + rects.get(id)!.w));
      const rightStart = Math.min(...["r1", "r5"].map((id) => rects.get(id)!.x));
      assert.ok(leftEdge <= rightStart + 0.5, `${width}: left ends at ${leftEdge}, right starts at ${rightStart}`);
      for (const rect of rects.values()) assert.ok(rect.x >= -0.5 && rect.x + rect.w <= width + 0.5, `${width}: inside the view`);
    }
  });

  it("hit testing finds the plate under a point, the cell of a segmented plate, and skips notes and disabled plates", () => {
    const groups: PlateGroup[] = [
      {
        id: "g",
        dock: "bottom",
        gap: 10,
        plates: [tab("a", 100), { id: "size", kind: "segments", label: "档案", options: ["小", "中", "大"], selected: 1, width: 200 }, { id: "note", kind: "note", label: "x", width: 100 }, tab("off", 100, { disabled: true })],
      },
    ];
    const rects = layoutGroups(groups, VIEW);
    const a = rects.get("a")!;
    assert.equal(hitPlate(groups, rects, a.x + 5, a.y + 5)?.id, "a");
    assert.equal(hitPlate(groups, rects, a.x - 20, a.y + 5), undefined);
    const size = rects.get("size")!;
    assert.equal(hitPlate(groups, rects, size.x + 2, size.y + 5)?.cell, 0);
    assert.equal(hitPlate(groups, rects, size.x + size.w / 2, size.y + 5)?.cell, 1);
    assert.equal(hitPlate(groups, rects, size.x + size.w - 2, size.y + 5)?.cell, 2);
    const note = rects.get("note")!;
    assert.equal(hitPlate(groups, rects, note.x + 5, note.y + 5), undefined);
    const off = rects.get("off")!;
    assert.equal(hitPlate(groups, rects, off.x + 5, off.y + 5), undefined);
    assert.ok(contains(a, a.x, a.y));
    assert.ok(!contains(a, a.x - 1, a.y));
    assert.ok(contains(a, a.x - 1, a.y, 2));
  });

  it("a top-left row starts at the corner, hangs from its margin, does not shrink with the bottom rows, and 'lift' raises a plate", () => {
    const groups: PlateGroup[] = [
      { id: "t", dock: "top-left", offset: 20, margin: 72, gap: 6, plates: [tab("t1", 70), tab("t2", 70, { lift: 6 })] },
      { id: "b", dock: "bottom", plates: [tab("b1", 4000)] },
    ];
    const rects = layoutGroups(groups, VIEW);
    const first = rects.get("t1")!;
    assert.equal(first.x, EDGE + 20);
    assert.equal(first.y, EDGE + 72);
    assert.equal(first.w, 70, "unaffected by the overfull bottom row");
    assert.equal(rects.get("t2")!.x, first.x + 70 + 6);
    assert.equal(rects.get("t2")!.y, first.y - 6);
  });

  it("an empty group takes no room", () => {
    const rects = layoutGroups([{ id: "e", dock: "bottom", plates: [] }], VIEW);
    assert.equal(rects.size, 0);
  });
});

describe("the disc", () => {
  it("sits in the top-right corner under the navigation bar; the big one is larger and both stay inside the view", () => {
    const small = discGeometry(VIEW, false);
    const big = discGeometry(VIEW, true);
    assert.ok(big.radius > small.radius);
    for (const disc of [small, big]) {
      assert.ok(disc.cx + disc.radius * 1.25 <= VIEW.width - EDGE + 0.5, "the ring of ticks stays inside the right margin");
      assert.ok(Math.abs(disc.cy - disc.radius * 1.25 - DISC_TOP) < 0.5, "its top is at the line under the navigation bar");
      assert.ok(disc.cx - disc.radius * 1.2 >= 0 && disc.cy + disc.radius * 1.2 <= VIEW.height);
    }
    assert.equal(big.radius, DISC_RADIUS.big);
    assert.ok(discReserve(true) > discReserve(false));
  });

  it("a row of plates docked top-right with the disc's margin is level with the disc and leaves the disc free", () => {
    for (const big of [false, true]) {
      const disc = discGeometry(VIEW, big);
      const groups: PlateGroup[] = [{ id: "g", dock: "top-right", offset: discReserve(big) - EDGE, margin: discRowMargin(big, 56), gap: 8, plates: [tab("a", 100, { height: 56 }), tab("b", 100, { height: 56 })] }];
      const rects = layoutGroups(groups, VIEW);
      const a = rects.get("a")!;
      const b = rects.get("b")!;
      assert.ok(Math.abs(a.y + a.h / 2 - disc.cy) < 0.5, `level with the disc (big: ${big})`);
      assert.ok(b.x + b.w <= disc.cx - disc.radius * 1.25 + 0.5, "the last plate ends before the disc's ring of ticks");
    }
  });

  it("the middle is the label (play / pause), the ring of ticks is the rim (seek), the rest is outside", () => {
    const disc = discGeometry(VIEW, true);
    assert.equal(discZone(disc, disc.cx, disc.cy), "label");
    assert.equal(discZone(disc, disc.cx + disc.radius * 0.8, disc.cy), "rim");
    assert.equal(discZone(disc, disc.cx + disc.radius * 1.15, disc.cy), "rim");
    assert.equal(discZone(disc, disc.cx + disc.radius * 1.5, disc.cy), "outside");
  });

  it("a turn runs clockwise from twelve o'clock, and the difference of two turns takes the short way round", () => {
    const disc = { cx: 100, cy: 100, radius: 50 };
    assert.ok(Math.abs(discTurn(disc, 100, 40) - 0) < 1e-9);
    assert.ok(Math.abs(discTurn(disc, 160, 100) - 0.25) < 1e-9);
    assert.ok(Math.abs(discTurn(disc, 100, 160) - 0.5) < 1e-9);
    assert.ok(Math.abs(discTurn(disc, 40, 100) - 0.75) < 1e-9);
    assert.ok(Math.abs(turnDelta(0.95, 0.05) - 0.1) < 1e-9);
    assert.ok(Math.abs(turnDelta(0.05, 0.95) + 0.1) < 1e-9);
    assert.ok(Math.abs(turnDelta(0.2, 0.3) - 0.1) < 1e-9);
  });
});

describe("QR code", () => {
  const finderOk = (modules: boolean[][], x0: number, y0: number) => {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(modules[y0 + dy][x0 + dx], ring !== 2, `finder at ${x0},${y0}: ${dx},${dy}`);
      }
    }
  };

  it("has the size of its version, three finder patterns, timing lines and the always-dark module", () => {
    const symbol = encodeQr("https://music.163.com/login?codekey=0123456789abcdef0123456789abcdef");
    assert.equal(symbol.size, symbol.version * 4 + 17);
    assert.equal(symbol.version, 5);
    finderOk(symbol.modules, 0, 0);
    finderOk(symbol.modules, symbol.size - 7, 0);
    finderOk(symbol.modules, 0, symbol.size - 7);
    for (let i = 8; i < symbol.size - 8; i++) {
      assert.equal(symbol.modules[6][i], i % 2 === 0);
      assert.equal(symbol.modules[i][6], i % 2 === 0);
    }
    assert.equal(symbol.modules[symbol.size - 8][8], true);
  });

  it("writes format bits that are a valid BCH codeword for level M and the chosen mask, in both copies", () => {
    const symbol = encodeQr("hello");
    const read = (cells: [number, number][]) => cells.reduce((value, [x, y], i) => value | ((symbol.modules[y][x] ? 1 : 0) << i), 0);
    const n = symbol.size;
    const first = read([[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]);
    const second = read([...Array.from({ length: 8 }, (_, i) => [n - 1 - i, 8] as [number, number]), ...Array.from({ length: 7 }, (_, i) => [8, n - 7 + i] as [number, number])]);
    assert.equal(first, second);
    const data = (first ^ 0x5412) >>> 10;
    assert.equal(data >>> 3, 0, "level M");
    assert.equal(data & 7, symbol.mask);
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    assert.equal(((data << 10) | remainder) ^ 0x5412, first);
  });

  it("chooses a larger version for longer text, is deterministic, and refuses text that does not fit", () => {
    const versions = ["A", "x".repeat(20), "x".repeat(60), "x".repeat(120), "x".repeat(QR_MAX_BYTES)].map((text) => encodeQr(text).version);
    assert.deepEqual(versions, [1, 2, 4, 7, 10]);
    assert.deepEqual(encodeQr("same").modules, encodeQr("same").modules);
    assert.throws(() => encodeQr("x".repeat(QR_MAX_BYTES + 1)), /too long/);
    assert.equal(encodeQr("琉匣 Vitrine").version, 1, "14 bytes fit the smallest symbol");
  });
});
