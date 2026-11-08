import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moveOrder, roll, unroll } from "../../src/regroup";

const unique = (values: number[]) => new Set(values).size === values.length;

describe("regrouping the ring into the row and back", () => {
  it("unrolling starts at the selected card and follows the ring round", () => {
    const plan = unroll(6, 6, 2);
    assert.deepEqual(plan.source, [2, 3, 4, 5, 0, 1]);
    assert.deepEqual(plan.spare, []);
  });

  it("every old card is used exactly once or is spare; none is lost, none appears twice", () => {
    for (const from of [1, 2, 5, 9, 30]) {
      for (const to of [0, 1, 4, 9, 20, 40]) {
        for (const anchor of [0, 1, from - 1]) {
          const plan = unroll(from, to, Math.max(0, anchor));
          const used = plan.source.filter((index) => index >= 0);
          assert.ok(unique(used), `${from}→${to}@${anchor}: card used twice`);
          assert.equal(used.length + plan.spare.length, from, `${from}→${to}@${anchor}: cards lost`);
          assert.equal(plan.source.length, to);
          assert.equal(plan.foldAt.length, plan.spare.length);
          for (const index of [...used, ...plan.spare]) assert.ok(index >= 0 && index < from);
        }
      }
    }
  });

  it("a bigger row is made up with new cards at the end, a smaller one folds the extra ring cards away", () => {
    const bigger = unroll(3, 7, 1);
    assert.deepEqual(bigger.source, [1, 2, 0, -1, -1, -1, -1]);
    const smaller = unroll(7, 3, 1);
    assert.deepEqual(smaller.source, [1, 2, 3]);
    assert.deepEqual(smaller.spare.sort(), [0, 4, 5, 6]);
  });

  it("the selected ring card becomes the selected row card, whatever the sizes", () => {
    for (const from of [1, 3, 8]) for (const anchor of [0, from - 1]) assert.equal(unroll(from, 5, anchor).source[0], anchor);
  });

  it("rolling back puts the selected row card on the selected ring item and continues round", () => {
    const plan = roll(10, 5, 3, 1);
    assert.equal(plan.source[1], 3);
    assert.equal(plan.source[2], 4);
    assert.equal(plan.source[3], 5);
    assert.equal(plan.source[4], 6);
    assert.equal(plan.source[0], 7); // the ring is smaller than what follows the selected card: it wraps round
    assert.deepEqual(plan.spare.sort((a, b) => a - b), [0, 1, 2, 8, 9]);
  });

  it("when the row has too few cards after the selected one, the cards before it complete the ring in order", () => {
    const plan = roll(6, 6, 4, 0);
    assert.deepEqual(plan.source, [4, 5, 0, 1, 2, 3]);
    assert.deepEqual(plan.spare, []);
  });

  it("rolling back never uses a card twice and accounts for all of them", () => {
    for (const from of [0, 1, 4, 12]) {
      for (const to of [1, 3, 8, 15]) {
        for (const fromAnchor of [0, 2, Math.max(0, from - 1)]) {
          const toAnchor = to > 1 ? 1 : 0;
          const plan = roll(from, to, Math.min(fromAnchor, Math.max(0, from - 1)), toAnchor);
          const used = plan.source.filter((index) => index >= 0);
          assert.ok(unique(used));
          assert.equal(used.length + plan.spare.length, from);
          assert.equal(plan.source.length, to);
        }
      }
    }
  });

  it("a row that is too small leaves the rest of the ring to new cards", () => {
    const plan = roll(2, 6, 0, 3);
    assert.equal(plan.source.filter((index) => index === -1).length, 4);
    assert.equal(plan.source[3], 0);
    assert.equal(plan.source[4], 1);
  });

  it("moving order grows with the distance from the selected card and wraps on a ring", () => {
    assert.deepEqual(moveOrder(5, 0, false), [0, 1, 2, 3, 4]);
    assert.deepEqual(moveOrder(5, 2, false), [2, 1, 0, 1, 2]);
    assert.deepEqual(moveOrder(6, 0, true), [0, 1, 2, 3, 2, 1]);
  });
});
