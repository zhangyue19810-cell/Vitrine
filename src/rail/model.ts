/**
 * The control rail's plain data and its layout: what plates there are, where they go on the screen, and which one is
 * under a point. No three.js and no DOM in here, so the arithmetic is tested on its own (`core/test/rail.test.ts`).
 *
 * A plate is an index tab of the archive: a thin slab with a label. Plates are put in groups that are docked to an edge of
 * the picture; the layout is in CSS pixels of the view, top-left origin.
 */

export type PlateKind =
  /** A button: a click does something. `active` marks the one that is on. */
  | "tab"
  /** One plate with several cells (small / medium / large): a click on a cell chooses it. */
  | "segments"
  /** A value that is changed by dragging along the plate or with the wheel. */
  | "slider"
  /** Text that is typed in (an invisible input takes the keys; the plate prints them). */
  | "field"
  /** Words only: a status line. It does not react to the pointer. */
  | "note";

export interface PlateSpec {
  id: string;
  kind: PlateKind;
  label: string;
  /** A second line or the value of a stepper (printed after the label). */
  value?: string;
  active?: boolean;
  disabled?: boolean;
  /** `segments`: the cells and the chosen one. */
  options?: string[];
  selected?: number;
  /** `slider`: 0…1. */
  amount?: number;
  /** `field`: the text typed so far, what to show when it is empty, and whether it has the keyboard. */
  text?: string;
  placeholder?: string;
  focused?: boolean;
  /** Width and height at scale 1, in px. */
  width: number;
  height?: number;
  /** The plate stands this many px higher than its neighbours (tabs of different heights read like a rack of index tabs). */
  lift?: number;
}

export type Dock = "bottom" | "bottom-left" | "bottom-right" | "top-left" | "top-right" | "right";

export interface PlateGroup {
  id: string;
  dock: Dock;
  plates: PlateSpec[];
  /** Space between plates, px at scale 1. */
  gap?: number;
  /** Distance to the docked edge, px at scale 1. */
  margin?: number;
  /** Shift along the edge, px at scale 1 (positive: away from the docked corner / to the right for the centred row). */
  offset?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const PLATE_HEIGHT = 40;
export const EDGE = 26;

/** How large everything on the rail is: 1 at about 1440 × 810, smaller on small windows, a little larger on big ones. */
export function railScale(view: Viewport): number {
  const by = Math.min(view.width / 1440, view.height / 810);
  return Math.min(1.25, Math.max(0.72, by));
}

export const plateHeight = (spec: PlateSpec) => spec.height ?? PLATE_HEIGHT;

/** The rectangle of every plate (keyed by id), after fitting the groups of one dock side by side without overlapping. */
export function layoutGroups(groups: readonly PlateGroup[], view: Viewport, scale = railScale(view)): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const usable = Math.max(120, view.width - EDGE * 2 * scale);
  // Groups of one dock share a row; if the row does not fit the screen, every group of it shrinks by the same factor.
  const rowsOf = (dock: Dock) => groups.filter((group) => group.dock === dock && group.plates.length);
  const widthOf = (group: PlateGroup) => group.plates.reduce((sum, plate) => sum + plate.width, 0) + (group.gap ?? 8) * Math.max(0, group.plates.length - 1);

  const bottomWidth = (["bottom-left", "bottom", "bottom-right"] as const).flatMap(rowsOf).reduce((sum, group) => sum + (widthOf(group) + (group.offset ?? 0)) * scale, 0);
  const fit = bottomWidth > usable ? usable / bottomWidth : 1;

  for (const group of groups) {
    if (!group.plates.length) continue;
    const top = group.dock === "top-left" || group.dock === "top-right";
    const s = scale * (group.dock === "right" || top ? 1 : fit);
    const gap = (group.gap ?? 8) * s;
    const margin = (group.margin ?? 0) * s;
    const offset = (group.offset ?? 0) * s;
    const total = widthOf(group) * s;
    const column = group.dock === "right";
    let x: number;
    let y: number;
    switch (group.dock) {
      case "bottom-left":
      case "top-left":
        x = EDGE * scale + offset;
        y = 0;
        break;
      case "bottom-right":
      case "top-right":
        x = view.width - EDGE * scale - total - offset;
        y = 0;
        break;
      case "right":
        x = view.width - EDGE * scale - Math.max(...group.plates.map((plate) => plate.width)) * s - offset;
        y = 0;
        break;
      default:
        x = (view.width - total) / 2 + offset;
        y = 0;
    }
    if (column) {
      const height = group.plates.reduce((sum, plate) => sum + plateHeight(plate) * s, 0) + gap * (group.plates.length - 1);
      let top = (view.height - height) / 2 + margin;
      for (const plate of group.plates) {
        const w = plate.width * s;
        const h = plateHeight(plate) * s;
        out.set(plate.id, { x: x + (Math.max(...group.plates.map((p) => p.width)) * s - w), y: top, w, h });
        top += h + gap;
      }
      continue;
    }
    const base = top ? EDGE * scale + margin : view.height - EDGE * scale - margin;
    for (const plate of group.plates) {
      const w = plate.width * s;
      const h = plateHeight(plate) * s;
      const lift = (plate.lift ?? 0) * s;
      const edge = top ? base - lift : base - h - lift;
      out.set(plate.id, { x, y: edge + y, w, h });
      x += w + gap;
    }
  }
  return out;
}

export function contains(rect: Rect, x: number, y: number, slop = 0): boolean {
  return x >= rect.x - slop && x <= rect.x + rect.w + slop && y >= rect.y - slop && y <= rect.y + rect.h + slop;
}

/** The plate under a point (the last one wins where plates overlap, as the topmost would) with the cell for a `segments` plate. */
export function hitPlate(groups: readonly PlateGroup[], rects: ReadonlyMap<string, Rect>, x: number, y: number): { id: string; cell?: number; along: number } | undefined {
  let found: { id: string; cell?: number; along: number } | undefined;
  for (const group of groups) {
    for (const plate of group.plates) {
      const rect = rects.get(plate.id);
      if (!rect || plate.kind === "note" || plate.disabled || !contains(rect, x, y)) continue;
      const along = rect.w > 0 ? Math.min(1, Math.max(0, (x - rect.x) / rect.w)) : 0;
      found = { id: plate.id, along, cell: plate.kind === "segments" && plate.options?.length ? Math.min(plate.options.length - 1, Math.floor(along * plate.options.length)) : undefined };
    }
  }
  return found;
}

// ------------------------------------------------------------------------------------------------ the music disc

/** Radius of the disc at scale 1: large in the music view, small everywhere else. */
export const DISC_RADIUS = { big: 66, mini: 34 } as const;

/** Width (px at scale 1) that a group docked next to the disc must leave free: the disc, its ticks and a gap. */
export const discReserve = (big: boolean) => EDGE + DISC_RADIUS[big ? "big" : "mini"] * 2.5 + 14;

export interface DiscGeometry {
  cx: number;
  cy: number;
  radius: number;
}

/** Where the top of the disc's ring of ticks is, px from the top at scale 1: just under the navigation bar of the page. */
export const DISC_TOP = 88;

/** Where the disc goes: the top-right corner under the navigation bar, small while another view is up and large in the music view. */
export function discGeometry(view: Viewport, big: boolean, scale = railScale(view)): DiscGeometry {
  const radius = DISC_RADIUS[big ? "big" : "mini"] * scale;
  return { cx: view.width - EDGE * scale - radius * 1.25, cy: DISC_TOP * scale + radius * 1.25, radius };
}

/** The `margin` of a top-right group of plates of height `height` that sits level with the disc's middle. */
export const discRowMargin = (big: boolean, height: number) => DISC_TOP + DISC_RADIUS[big ? "big" : "mini"] * 1.25 - height / 2 - EDGE;

/** What a point on the disc means: the label in the middle plays or pauses, the rim (the ring of ticks) is for seeking. */
export function discZone(disc: DiscGeometry, x: number, y: number): "label" | "rim" | "outside" {
  const distance = Math.hypot(x - disc.cx, y - disc.cy);
  if (distance <= disc.radius * 0.5) return "label";
  if (distance <= disc.radius * 1.22) return "rim";
  return "outside";
}

/** Angle of a point around the disc, clockwise from the top, as a fraction of a turn in [0, 1). */
export function discTurn(disc: DiscGeometry, x: number, y: number): number {
  const angle = Math.atan2(x - disc.cx, -(y - disc.cy));
  return ((angle / (Math.PI * 2)) % 1 + 1) % 1;
}

/** The nearest way round from a turn `from` to a turn `to`, as a signed fraction in (−0.5, 0.5]. */
export function turnDelta(from: number, to: number): number {
  let delta = (to - from) % 1;
  if (delta > 0.5) delta -= 1;
  else if (delta <= -0.5) delta += 1;
  return delta;
}
