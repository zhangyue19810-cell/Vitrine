/**
 * Which archive becomes which when the picture changes shape.
 *
 * The launcher keeps one set of archives. When the Möbius ring turns into the download row (or back) nothing is thrown
 * away: every archive of the old picture flies to a place in the new one, and only the difference in numbers is made up
 * by archives that swirl in from below (when the new picture is bigger) or fold into the band (when it is smaller).
 * These functions only do the bookkeeping, with plain indices, so it can be tested without a GPU.
 */

export interface RegroupPlan {
  /** For each item of the new picture: the index of the old card that becomes it, or −1 when a new card has to arrive. */
  source: number[];
  /** Old cards that have no place in the new picture. They fly towards `foldAt` and shrink away. */
  spare: number[];
  /** For each spare card: the new-picture item whose place it should drift towards (so it still travels with the others). */
  foldAt: number[];
}

/**
 * Unroll the ring into the row. The selected card of the ring (`fromAnchor`) becomes the first item of the row, the
 * cards after it follow in ring order, wrapping round, so the ring is cut open at the selected card.
 */
export function unroll(fromCount: number, toCount: number, fromAnchor: number): RegroupPlan {
  const source: number[] = [];
  for (let item = 0; item < toCount; item++) {
    source.push(item < fromCount ? (((fromAnchor + item) % fromCount) + fromCount) % fromCount : -1);
  }
  const used = new Set(source);
  const spare: number[] = [];
  const foldAt: number[] = [];
  for (let k = 0; k < fromCount; k++) {
    const old = (((fromAnchor + k) % fromCount) + fromCount) % fromCount;
    if (!used.has(old)) {
      spare.push(old);
      foldAt.push(Math.max(0, toCount - 1));
    }
  }
  return { source, spare, foldAt };
}

/**
 * Roll the row back into a ring. The row's selected card (`fromAnchor`) goes to the ring's selected item (`toAnchor`)
 * and the cards after it continue round the ring, wrapping; cards before the selected one have no natural place and fold
 * away unless the ring is bigger than the row and has room left.
 */
export function roll(fromCount: number, toCount: number, fromAnchor: number, toAnchor: number): RegroupPlan {
  const source: number[] = Array.from({ length: toCount }, () => -1);
  const taken = new Set<number>();
  // The selected card and those after it, in order.
  for (let rank = 0; rank < toCount; rank++) {
    const old = fromAnchor + rank;
    if (old < 0 || old >= fromCount) break;
    source[(((toAnchor + rank) % toCount) + toCount) % toCount] = old;
    taken.add(old);
  }
  // Cards before the selected one fill the remaining places backwards, so a ring that is bigger than the row is
  // completed with the nearest cards rather than with strangers.
  for (let rank = 1; rank <= fromAnchor; rank++) {
    const old = fromAnchor - rank;
    if (old < 0 || old >= fromCount) break;
    const place = (((toAnchor - rank) % toCount) + toCount) % toCount;
    if (source[place] !== -1) break;
    source[place] = old;
    taken.add(old);
  }
  const spare: number[] = [];
  const foldAt: number[] = [];
  for (let old = 0; old < fromCount; old++) {
    if (taken.has(old)) continue;
    spare.push(old);
    foldAt.push(Math.max(0, Math.min(toCount - 1, toAnchor)));
  }
  return { source, spare, foldAt };
}

/** Starting order of the moving cards: the selected card first, then outwards, so the swirl spreads from the middle. */
export function moveOrder(count: number, anchor: number, wrapped: boolean): number[] {
  const order = new Array<number>(count);
  for (let item = 0; item < count; item++) {
    let distance = Math.abs(item - anchor);
    if (wrapped && count > 0) distance = Math.min(distance, count - distance);
    order[item] = distance;
  }
  return order;
}
