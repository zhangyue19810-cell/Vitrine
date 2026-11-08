import * as THREE from "three";
import { newFrame, wrapSigned, type RingFrame } from "./mobius-ring";
import { BAND, BandPath, TRACK, newPlate, lapFlip, plateAt, turnPlate, type PlateFrame } from "./fin-band";
import { FinMesh } from "./fin-mesh";
import { ROW, rowFrame } from "./row-track";
import {
  TIMING,
  delayOf,
  enterOffset,
  exitOffset,
  flightDelay,
  flightEase,
  flightOffset,
  FLIGHT,
  seedOf,
  type Offset,
  type Seed,
  type Style,
} from "./choreography";
import { roll, unroll } from "./regroup";
import { basisOf, detailPlacement, fovOf, holePlacement, ringCamera, rowCamera, type CameraPreset, type DetailPlacement } from "./stage-layout";
import { damp, type Spring } from "./motion";

/**
 * The 3D stage of the launcher: ONE set of archives that is either the Möbius ring (home) or the single download row,
 * and that never disappears when the picture changes: switching views regroups the same archives (each one flies along
 * its own swirl to its new place and turns its face over on the way), the band of plates unrolls into the track, and
 * only the difference in numbers is made up by archives that swirl in from below or fold into the band.
 * Inside the download view, switching category pulls the cards apart to both sides and new cards fly in from all around.
 *
 * The stage owns poses, motion, faces (what is printed on each archive), the plates of the ring, picking and the camera target. It
 * does not draw the archives' glass shells: the scene reads `matrices` (one 4×4 per drawn card) and draws them with the
 * same instanced meshes the old shelf used, so the archives look exactly like they always did.
 */

export type StageLayout = "ring" | "row";

export interface StageItem {
  /** Identity of the thing shown; two items with the same key are the same archive. */
  key: string;
  /** Bump when the payload changes (an icon arrived, a count was updated) to repaint the faces. */
  revision?: number;
  payload: unknown;
}

export type FaceVariant = "card" | "info" | "detail";

/** A clickable rectangle on a face, in face coordinates (0…1, origin top-left). */
export interface Hotspot {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FaceState {
  dark: boolean;
  /** Hotspot under the pointer (for a hover highlight), or null. */
  hot: string | null;
  index: number;
  count: number;
}

/** Paints the faces; supplied by the app so the stage knows nothing about instances or mods. */
export interface FacePainter {
  size(variant: FaceVariant): { width: number; height: number };
  paint(ctx: CanvasRenderingContext2D, variant: FaceVariant, item: StageItem, state: FaceState): Hotspot[];
}

export interface StagePick {
  item: number;
  hotspot: string | null;
  /** True when the pointer is on the pulled-out (detail) card. */
  detail: boolean;
}

export interface StageEvents {
  select?(item: number): void;
  activate?(item: number): void;
  action?(id: string, item: number): void;
  hover?(item: number | null): void;
  /** The row is nearly at its end: load more. */
  more?(): void;
}

export const STAGE = {
  capacity: 64,
  /** Row cards that exist at a time: from `before` slots left of the selected card to `after` slots right of it. */
  before: 2,
  after: 9,
};

const CARD = { mid: 1.85, midZ: 0.06, halfWidth: 2.5, height: 3.7 };
const FACE = { width: 4.56, height: 3.3, z: 0.262 };
/** Archives on the band stand a little larger than the plates around them, so they read as the tabs of the card file. */
const RING_CARD = { scale: 1.22, arc: 3.4 };

const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class Pose {
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  scale = 1;
  copy(other: Pose) {
    this.pos.copy(other.pos);
    this.quat.copy(other.quat);
    this.scale = other.scale;
    return this;
  }
}

type Mode = "away" | "rest" | "fly" | "enter" | "leave";

class Face {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  key = "";
  revision = -2;
  dark = false;
  hot: string | null = null;
  hotspots: Hotspot[] = [];
  constructor(readonly variant: FaceVariant, painter: FacePainter, geometry: THREE.BufferGeometry, anisotropy: number) {
    const { width, height } = painter.size(variant);
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // The printed faces are decals: the ambient-occlusion pass must not treat them as solid geometry.
    this.mesh.userData.excludeFromAO = true;
    this.mesh.renderOrder = variant === "card" ? 3 : variant === "info" ? 4 : 5;
  }
  /** Repaint when the content, theme or highlighted hotspot changed. Returns true if it painted. */
  paint(painter: FacePainter, item: StageItem, state: FaceState, force = false): boolean {
    const revision = item.revision ?? 0;
    if (!force && this.key === item.key && this.revision === revision && this.dark === state.dark && this.hot === state.hot) return false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.hotspots = painter.paint(this.ctx, this.variant, item, state);
    this.key = item.key;
    this.revision = revision;
    this.dark = state.dark;
    this.hot = state.hot;
    this.texture.needsUpdate = true;
    return true;
  }
  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}

class Card {
  mode: Mode = "away";
  /** Item index this card is (or is flying to become). */
  item = -1;
  /** Item index its face was painted for, and that item itself (the face is swapped half-way through a flight, and the
   *  index space changes with the layout, so the item object is what identifies the printed content). */
  shown = -1;
  shownItem: StageItem | undefined;
  t = 0;
  duration = 1;
  style: Style = "spiral";
  seed: Seed = [0, 0, 0, 0];
  side = 0;
  spare = false;
  readonly from = new Pose();
  readonly pose = new Pose();
  readonly matrix = new THREE.Matrix4();
  readonly hover: Spring = { value: 0, velocity: 0 };
  drawn = false;
  face?: Face;
  constructor(readonly id: number) {}
}

const scratch = {
  frame: newFrame() as RingFrame,
  basis: new THREE.Matrix4(),
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  euler: new THREE.Euler(0, 0, 0, "YXZ"),
  target: new Pose(),
  detail: new Pose(),
  offset: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, scale: 1 } as Offset,
  inverse: new THREE.Matrix4(),
  ray: new THREE.Ray(),
  hit: new THREE.Vector3(),
  axisY: new THREE.Vector3(0, 1, 0),
};

export class ArchiveStage {
  readonly group = new THREE.Group();
  events: StageEvents = {};

  layout: StageLayout = "ring";
  items: StageItem[] = [];
  /** Selected item (the front card of the ring / the pulled-out card of the row). */
  selected = 0;

  /** One 4×4 per drawn card, packed from index 0; `count` valid entries. Read by the scene. */
  readonly matrices = new Float32Array(STAGE.capacity * 16);
  /** Distance of each drawn card from the selected one in slots (drives the theme wave). */
  readonly distances = new Float32Array(STAGE.capacity);
  count = 0;
  /** Seconds since the picture last changed shape; the scene redraws every frame while this is moving. */
  animating = false;
  /** True while a regrouping or category swap is running (clicks are ignored so cards are not grabbed mid-flight). */
  busy = false;
  /** Waiting for the content of a category swap. */
  loading = false;
  focus = new THREE.Vector3();

  private readonly cards: Card[] = [];
  private readonly cardOfItem = new Map<number, Card>();
  private readonly painter: FacePainter;
  private readonly anisotropy: number;
  private readonly faceGeometry: THREE.PlaneGeometry;
  private readonly infoFace: Face;
  private readonly detailFace: Face;
  /** The Möbius ring's plates (the same ones become the track of the download view). */
  readonly fins = new FinMesh();
  private readonly bandPath = new BandPath();
  private readonly plate: PlateFrame = newPlate();
  private readonly assemble: Spring = { value: 0, velocity: 0 };
  private clock = 0;
  private ambient = true;
  /** Lap fraction the ring had turned by when it last became the row: the track is laid out from the plates in that order. */
  private finTurn = 0;
  private finAnchor = 0;
  private started = false;
  private readonly holeSpot = new Pose();
  private readonly detailSpot = new Pose();
  private readonly towardEye = new THREE.Vector3(0, 0, 1);
  private readonly ringPos: Spring = { value: 0, velocity: 0 };
  private readonly rowPos: Spring = { value: 0, velocity: 0 };
  private readonly pull: Spring = { value: 0, velocity: 0 };
  private readonly morph: Spring = { value: 0, velocity: 0 };
  private readonly camSprings: Spring[] = Array.from({ length: 8 }, () => ({ value: 0, velocity: 0 }));
  private camReady = false;
  private aspect = 16 / 9;
  private dark = false;
  private presence = 1;
  private detailOn = false;
  private hoverItem = -1;
  private hoverHot: string | null = null;
  private dragging = false;
  private pending: StageItem[] | null = null;
  private swapping = false;
  private stamp = 0;
  private instant = false;
  private detailItem = -1;

  constructor(options: { painter: FacePainter; anisotropy?: number }) {
    this.painter = options.painter;
    this.anisotropy = options.anisotropy ?? 4;
    this.faceGeometry = new THREE.PlaneGeometry(FACE.width, FACE.height);
    this.faceGeometry.translate(0, CARD.mid, FACE.z);
    this.infoFace = new Face("info", this.painter, this.faceGeometry, this.anisotropy);
    this.detailFace = new Face("detail", this.painter, this.faceGeometry, this.anisotropy);
    this.group.add(this.infoFace.mesh, this.detailFace.mesh);

    this.group.add(this.fins.mesh);
  }

  /** How far the selected archive is pulled out to the left (0…1); in the row it always is. */
  get pullAmount() {
    return this.layout === "row" ? 1 : this.pull.value;
  }

  /** 0 while the plates form the Möbius band, 1 once they are the flat track. */
  get layoutBlend() {
    return clamp(this.morph.value, 0, 1);
  }

  /** Two slots whose screen distance is "one step" of scrolling (in the row the pulled-out card at slot 0 is left out). */
  referenceSlots(): [number, number] {
    return this.layout === "ring" ? [0, 1] : [1, 2];
  }

  /** World position of the middle of the card `slot` places along (ring: counted from the focus, on the band; row: the track slot). */
  slotCentre(slot: number, out: THREE.Vector3): THREE.Vector3 {
    if (this.layout === "ring") {
      this.bandPose(slot, Math.max(1, this.items.length), scratch.target);
      return out.copy(scratch.target.pos);
    }
    const frame = rowFrame(slot, scratch.frame);
    return out.set(frame.point[0], frame.point[1], frame.point[2]);
  }

  // ───────────────────────────── content ─────────────────────────────

  get busyOrLoading() {
    return this.busy || this.loading;
  }

  setAspect(aspect: number) {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect;
  }

  setDark(dark: boolean) {
    if (dark === this.dark) return;
    this.dark = dark;
    this.repaintAll();
  }

  /** The scene's light↔dark blend (0 … 1), so the plates change colour with the background instead of jumping. */
  setThemeAmount(amount: number) {
    this.fins.setTheme(amount);
  }

  /** Whether the ring undulates slowly while nothing is happening (the "idle motion" preference). */
  setAmbient(on: boolean) {
    this.ambient = on;
  }

  /** Repaint every face (the theme changed, or the fonts / icons the painter uses have just arrived). */
  repaintAll() {
    for (const card of this.cards) {
      if (card.face && card.shownItem && card.mode !== "away") this.paintCard(card, true);
    }
    if (this.hoverItem >= 0) this.paintInfo();
    if (this.detailItem >= 0) this.paintDetail(true);
  }

  setPresence(presence: number) {
    this.presence = clamp(presence, 0, 1);
  }

  /** Whether motion should be skipped (reduced-motion): transitions finish at once. */
  setInstant(instant: boolean) {
    this.instant = instant;
  }

  /**
   * Show `items` in `layout`. The first call places the archives with a swirl from below; a different layout regroups the
   * archives that are already there; the same layout with other items re-seats them (see `swapItems` for the category
   * switch of the download view).
   */
  setItems(layout: StageLayout, items: StageItem[], selected = 0) {
    const count = layout === "ring" ? Math.min(items.length, STAGE.capacity) : items.length;
    items = items.slice(0, layout === "ring" ? STAGE.capacity : items.length);
    selected = clamp(selected, 0, Math.max(0, count - 1));
    const bound = this.boundCards();
    this.swapping = false;
    this.pending = null;
    this.loading = false;
    if (bound.length === 0 || (this.items.length === 0 && this.layout === layout)) {
      this.layout = layout;
      this.items = items;
      this.selected = selected;
      this.ringPos.value = this.ringPos.velocity = 0;
      this.rowPos.value = this.rowPos.velocity = 0;
      if (layout === "ring") this.ringPos.value = selected;
      else this.rowPos.value = selected;
      this.ringTarget = this.ringPos.value;
      this.rowTarget = this.rowPos.value;
      this.hoverItem = -1;
      this.morph.value = layout === "row" ? 1 : 0;
      this.finTurn = layout === "ring" ? selected / Math.max(1, items.length) : 0;
      this.finAnchor = this.rowPos.value;
      if (!this.started) {
        this.started = true;
        this.assemble.value = this.instant ? 1 : 0;
        this.assemble.velocity = 0;
      }
      this.placeAll("spiral");
      return;
    }
    if (layout !== this.layout) {
      this.regroup(layout, items, selected);
      return;
    }
    if (layout === "ring") this.reseatRing(items, selected);
    else this.swapItems(items);
  }

  /** The download view's category switch: pull the cards apart, then gather new ones (when `items` is null: wait for them). */
  swapItems(items: StageItem[] | null) {
    if (this.swapping) {
      // Already pulling apart (or waiting for content): only the content changes, the cards are not grabbed again.
      this.pending = items;
      this.loading = items === null;
      this.updateBusy();
      return;
    }
    this.pending = items;
    this.swapping = true;
    this.loading = items === null;
    this.items = [];
    this.hoverItem = -1;
    this.detailItem = -1;
    this.setHoverReset();
    const bound = this.boundCards();
    const centre = this.cameraRight();
    bound.sort((a, b) => a.pose.pos.dot(centre) - b.pose.pos.dot(centre));
    bound.forEach((card, order) => {
      this.cardOfItem.delete(card.item);
      this.leave(card, order, card.pose.pos.dot(centre) < this.aim().dot(centre) ? -1 : 1);
    });
    this.updateBusy();
  }

  /** Add items to the end of the row (the next page of results). */
  appendItems(items: StageItem[]) {
    if (this.swapping) {
      this.pending = [...(this.pending ?? []), ...items];
      return;
    }
    this.items = this.items.concat(items);
  }

  /** Replace the payload of one item (an icon arrived, a number changed); its faces are repainted. */
  updateItem(index: number, item: StageItem) {
    if (index < 0 || index >= this.items.length) return;
    const previous = this.items[index];
    this.items[index] = item;
    const card = this.cardOfItem.get(index);
    // A card that already shows this item gets the new print; one still on its way swaps to it half-way through the flight.
    if (card && card.shownItem === previous) this.show(card, index);
    if (this.hoverItem === index) this.paintInfo();
    if (this.detailItem === index) this.paintDetail(true);
  }

  /**
   * The same row with better content (the real search results replace the placeholders it was filled with): cards keep their
   * places and are repainted, missing ones swirl in, surplus ones leave. A category swap that is still waiting just receives it.
   */
  replaceItems(items: StageItem[]) {
    if (this.swapping) {
      this.pending = items;
      this.loading = false;
      return;
    }
    if (this.layout !== "row") {
      this.items = items;
      return;
    }
    const previous = this.items;
    this.items = items;
    this.selected = clamp(this.selected, 0, Math.max(0, items.length - 1));
    this.rowTarget = clamp(this.rowTarget, 0, Math.max(0, items.length - 1));
    const wanted = new Set(this.wanted("row", items.length, this.selected));
    let order = 0;
    for (const [index, card] of [...this.cardOfItem]) {
      if (wanted.has(index)) {
        const before = previous[index];
        if (card.shownItem === before || card.shownItem === undefined) this.show(card, index);
        continue;
      }
      this.cardOfItem.delete(index);
      this.leave(card, order++, index < this.selected ? -1 : 1);
    }
    for (const index of wanted) {
      if (this.cardOfItem.has(index)) continue;
      const card = this.freeCard();
      if (card) this.enter(card, index, order++, "spiral");
    }
    if (this.hoverItem >= 0) this.paintInfo();
    if (this.detailItem >= 0) this.paintDetail(true);
    this.updateBusy();
  }

  private boundCards() {
    return this.cards.filter((card) => card.mode !== "away" && !card.spare);
  }

  private freeCard(): Card | undefined {
    let card = this.cards.find((c) => c.mode === "away");
    if (!card && this.cards.length < STAGE.capacity) {
      card = new Card(this.cards.length);
      this.cards.push(card);
    }
    return card;
  }

  private wanted(layout: StageLayout, count: number, selected: number): number[] {
    if (layout === "ring") return Array.from({ length: Math.min(count, STAGE.capacity) }, (_, i) => i);
    const from = Math.max(0, selected - STAGE.before);
    const to = Math.min(count - 1, selected + STAGE.after);
    return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  }

  /** First placement: every card swirls in from below. */
  private placeAll(style: Style) {
    for (const card of this.cards) this.release(card);
    this.cardOfItem.clear();
    const wanted = this.wanted(this.layout, this.items.length, this.selected);
    const centre = this.layout === "ring" ? this.selected : this.selected;
    wanted.forEach((item) => {
      const card = this.freeCard();
      if (!card) return;
      this.enter(card, item, Math.abs(item - centre), style);
    });
    this.updateBusy();
  }

  private release(card: Card) {
    card.mode = "away";
    card.item = -1;
    card.shown = -1;
    card.shownItem = undefined;
    card.spare = false;
    card.drawn = false;
    if (card.face) card.face.mesh.visible = false;
  }

  private nextSeed(card: Card): Seed {
    this.stamp++;
    return seedOf(card.id * 31 + this.stamp * 7);
  }

  private enter(card: Card, item: number, order: number, style: Style, extraDelay = 0) {
    card.seed = this.nextSeed(card);
    card.item = item;
    card.spare = false;
    card.style = style;
    card.mode = "enter";
    card.t = -(delayOf(style, order, card.seed) + extraDelay);
    card.duration = TIMING[style].enter;
    card.side = 0;
    this.cardOfItem.set(item, card);
    this.show(card, item);
    if (this.instant) card.mode = "rest";
  }

  private fly(card: Card, item: number, order: number, spare = false, extraDelay = 0) {
    card.seed = this.nextSeed(card);
    card.from.copy(card.pose);
    card.item = item;
    card.spare = spare;
    card.mode = "fly";
    card.t = -(flightDelay(order, card.seed) + extraDelay);
    card.duration = FLIGHT.duration;
    if (!spare) this.cardOfItem.set(item, card);
    if (this.instant) {
      card.mode = spare ? "away" : "rest";
      if (spare) this.release(card);
      else this.show(card, item);
    }
  }

  private leave(card: Card, order: number, side: number) {
    card.seed = this.nextSeed(card);
    card.from.copy(card.pose);
    card.mode = "leave";
    card.style = "scatter";
    card.side = side;
    card.spare = false;
    card.t = -delayOf("scatter", order, card.seed) * 0.5;
    card.duration = TIMING.scatter.exit;
    if (this.instant) this.release(card);
  }

  /** Make the face of `card` show `item` (an index into the current items) now. */
  private show(card: Card, item: number) {
    card.shown = item;
    card.shownItem = this.items[item];
    this.paintCard(card, true);
  }

  /** Whether the card's printed face is the one of the item it belongs to. */
  private fresh(card: Card) {
    return card.item >= 0 && card.shownItem !== undefined && card.shownItem === this.items[card.item];
  }

  private paintCard(card: Card, force = false) {
    const item = card.shownItem;
    if (!item) return;
    card.face ??= this.makeFace();
    const state: FaceState = { dark: this.dark, hot: null, index: card.shown, count: this.items.length };
    card.face.paint(this.painter, item, state, force);
  }

  private makeFace(): Face {
    const face = new Face("card", this.painter, this.faceGeometry, this.anisotropy);
    this.group.add(face.mesh);
    return face;
  }

  /** The ring turned into the row, or the row into the ring: the same archives fly to their new places. */
  private regroup(layout: StageLayout, items: StageItem[], selected: number) {
    const oldCount = this.items.length;
    const oldSelected = this.selected;
    const oldCards = new Map(this.cardOfItem);
    const spares: Card[] = this.cards.filter((card) => card.mode !== "away" && card.spare);
    // The plates of the band are laid out along the track in the order they have on the ring right now.
    if (this.layout === "ring") this.finTurn = this.ringPos.value / Math.max(1, oldCount);
    this.cardOfItem.clear();
    this.layout = layout;
    this.items = items;
    this.selected = selected;
    this.hoverItem = -1;
    this.setHoverReset();
    if (layout === "ring") {
      this.ringPos.value = this.ringTarget = selected;
      this.ringPos.velocity = 0;
    } else {
      this.rowPos.value = this.rowTarget = selected;
      this.rowPos.velocity = 0;
      this.finAnchor = selected;
    }
    const wanted = this.wanted(layout, items.length, selected);
    const toCount = layout === "row" ? wanted.length : items.length;
    // In the row only the window around the selected card exists; the plan maps old items to the new ones one by one.
    const plan = layout === "row" ? unroll(oldCount, toCount, oldSelected) : roll(oldCount, toCount, oldSelected, selected);
    const used = new Set<Card>();
    let enterOrder = 0;
    wanted.forEach((item, rank) => {
      const old = plan.source[layout === "row" ? rank : item];
      const card = old !== undefined && old >= 0 ? oldCards.get(old) : undefined;
      if (card && !used.has(card)) {
        used.add(card);
        this.fly(card, item, layout === "row" ? rank : Math.abs(wrapSigned(item - selected, Math.max(1, items.length))));
      } else {
        const fresh = this.freeCard();
        if (!fresh) return;
        used.add(fresh);
        this.enter(fresh, item, enterOrder++, "spiral", 0.35);
      }
    });
    // Whatever is left folds into the band while it travels with the others.
    let foldOrder = 0;
    for (const card of [...oldCards.values(), ...spares]) {
      if (used.has(card) || card.mode === "away") continue;
      used.add(card);
      const target = layout === "row" ? Math.min(wanted[wanted.length - 1] ?? 0, selected + STAGE.after) : (wanted[Math.min(foldOrder, wanted.length - 1)] ?? 0);
      this.fly(card, target, foldOrder++ + 2, true);
    }
    this.updateBusy();
  }

  /** Same layout (ring), different items: cards with the same key keep their archive and glide to the new place. */
  private reseatRing(items: StageItem[], selected: number) {
    const oldByKey = new Map<string, Card>();
    for (const [index, card] of this.cardOfItem) {
      const key = this.items[index]?.key;
      if (key !== undefined) oldByKey.set(key, card);
    }
    const oldCount = this.items.length;
    const oldPosition = this.ringPos.value;
    this.cardOfItem.clear();
    this.items = items;
    const keep = Math.min(items.length, STAGE.capacity);
    // The selection follows the item it was on: the ring settles with that archive at the front.
    this.selected = clamp(selected, 0, Math.max(0, keep - 1));
    this.ringPos.value = this.ringTarget = this.selected;
    this.ringPos.velocity = 0;
    const geometryChanged = keep !== oldCount || this.ringPos.value !== oldPosition;
    const used = new Set<Card>();
    let order = 0;
    for (let item = 0; item < keep; item++) {
      const card = oldByKey.get(items[item].key);
      if (card && !used.has(card) && card.mode !== "leave" && card.mode !== "away") {
        used.add(card);
        this.cardOfItem.set(item, card);
        const moved = card.item !== item || geometryChanged;
        card.item = item;
        card.spare = false;
        if (moved) {
          // From wherever it is on the screen now to its new place: no jump, whatever the ring did meanwhile.
          card.from.copy(card.pose);
          card.mode = "fly";
          card.seed = this.nextSeed(card);
          card.t = -0.04 * order++;
          card.duration = 0.75;
        }
        const shown = card.shownItem;
        // The same print as before (nothing about this archive changed): keep the painted face instead of repainting it.
        if (shown && shown.key === items[item].key && (shown.revision ?? 0) === (items[item].revision ?? 0)) {
          card.shown = item;
          card.shownItem = items[item];
        } else this.show(card, item);
      } else {
        const fresh = this.freeCard();
        if (!fresh) continue;
        used.add(fresh);
        this.enter(fresh, item, order++, "spiral");
      }
    }
    for (const card of this.cards) {
      if (used.has(card) || card.mode === "away" || card.spare) continue;
      this.fly(card, Math.min(this.selected, Math.max(0, keep - 1)), 1, true);
    }
    this.updateBusy();
  }

  // ───────────────────────────── selection and input ─────────────────────────────

  get selectedItem(): number {
    return this.selected;
  }

  /** Move the selection (ring: the shortest way round; row: scroll). */
  select(index: number) {
    if (this.items.length === 0) return;
    index = this.layout === "ring" ? ((index % this.items.length) + this.items.length) % this.items.length : clamp(index, 0, this.items.length - 1);
    if (this.layout === "ring") {
      this.ringTarget = this.ringPos.value + wrapSigned(index - this.ringPos.value, this.items.length);
    } else {
      this.rowTarget = index;
    }
    if (index !== this.selected) {
      this.selected = index;
      this.events.select?.(index);
    }
    if (this.layout === "row" && this.items.length - index <= STAGE.after && !this.swapping) this.events.more?.();
  }

  step(delta: number) {
    if (this.busy) return;
    this.select(this.selected + delta);
  }

  private setHoverReset() {
    this.infoFace.mesh.visible = false;
    for (const card of this.cards) {
      card.hover.value = 0;
      card.hover.velocity = 0;
    }
  }

  private ringTarget = 0;
  private rowTarget = 0;

  /** Dragging scrolls by `slots` (fractional); `end()` lets it settle on the nearest card. */
  dragBy(slots: number) {
    if (this.busy || this.items.length === 0) return;
    this.dragging = true;
    if (this.layout === "ring") {
      this.ringPos.value += slots;
      this.ringTarget = this.ringPos.value;
    } else {
      this.rowPos.value = clamp(this.rowPos.value + slots, 0, this.items.length - 1);
      this.rowTarget = this.rowPos.value;
    }
  }

  endDrag(velocitySlots = 0) {
    if (!this.dragging) return;
    this.dragging = false;
    const value = this.layout === "ring" ? this.ringPos.value : this.rowPos.value;
    const coast = clamp(velocitySlots * 0.25, -3, 3);
    this.select(Math.round(value + coast));
  }

  setDetail(on: boolean) {
    this.detailOn = on;
  }

  get detailOpen() {
    return this.detailOn;
  }

  setHover(item: number | null, hot: string | null = null) {
    const next = item ?? -1;
    if (next === this.hoverItem && hot === this.hoverHot) return;
    const changed = next !== this.hoverItem;
    this.hoverItem = next;
    this.hoverHot = hot;
    if (changed) {
      this.infoFace.mesh.visible = false;
      if (next >= 0) this.paintInfo();
      this.events.hover?.(next >= 0 ? next : null);
    }
    if (this.detailItem >= 0 && this.detailItem === this.selected) this.paintDetail();
  }

  private paintInfo() {
    const item = this.items[this.hoverItem];
    if (!item) return;
    this.infoFace.paint(this.painter, item, { dark: this.dark, hot: null, index: this.hoverItem, count: this.items.length }, true);
  }

  private paintDetail(force = false) {
    const item = this.items[this.detailItem];
    if (!item) return;
    this.detailFace.paint(this.painter, item, { dark: this.dark, hot: this.hoverHot, index: this.detailItem, count: this.items.length }, force);
  }

  /** What is under the ray: the card, and the hotspot of its pulled-out face. */
  pick(ray: THREE.Ray): StagePick | null {
    if (this.busy) return null;
    let best: StagePick | null = null;
    let bestT = Infinity;
    for (const card of this.cards) {
      if (!card.drawn || card.item < 0 || card.mode === "leave") continue;
      scratch.inverse.copy(card.matrix).invert();
      scratch.ray.copy(ray).applyMatrix4(scratch.inverse);
      const dz = scratch.ray.direction.z;
      if (dz > -1e-6) continue;
      // The local ray is normalised, so its parameter is in local units; the card may be scaled (the detail card is).
      const t = ((FACE.z - scratch.ray.origin.z) / dz) * card.matrix.getMaxScaleOnAxis();
      if (t < 0 || t >= bestT) continue;
      const local = (FACE.z - scratch.ray.origin.z) / dz;
      const x = scratch.ray.origin.x + scratch.ray.direction.x * local;
      const y = scratch.ray.origin.y + scratch.ray.direction.y * local;
      if (Math.abs(x) > CARD.halfWidth || y < 0 || y > CARD.height) continue;
      bestT = t;
      const onDetail = card.item === this.detailItem && this.detailVisible() > 0.5;
      let hotspot: string | null = null;
      if (onDetail) {
        const u = (x + FACE.width / 2) / FACE.width;
        const v = 1 - (y - (CARD.mid - FACE.height / 2)) / FACE.height;
        hotspot = this.detailFace.hotspots.find((h) => u >= h.x0 && u <= h.x1 && v >= h.y0 && v <= h.y1)?.id ?? null;
      }
      best = { item: card.item, hotspot, detail: onDetail };
    }
    return best;
  }

  /** A click: a hotspot acts, the selected card opens, another card becomes selected. */
  click(pick: StagePick | null) {
    if (!pick || this.busy) return;
    if (pick.hotspot) this.events.action?.(pick.hotspot, pick.item);
    else if (pick.item === this.selected) this.events.activate?.(pick.item);
    else this.select(pick.item);
  }

  private detailVisible() {
    return this.layout === "row" ? 1 : this.pull.value;
  }

  // ───────────────────────────── camera ─────────────────────────────

  private aim() {
    return new THREE.Vector3(this.camSprings[0].value, this.camSprings[1].value, this.camSprings[2].value);
  }

  private cameraRight() {
    const state = this.cameraState();
    const basis = basisOf({ dir: [state.dir[0], state.dir[1], state.dir[2]] });
    return new THREE.Vector3(basis.right[0], basis.right[1], basis.right[2]);
  }

  /** Where the camera should be for the current layout. */
  private cameraGoal(): CameraPreset {
    return this.layout === "ring" ? ringCamera(this.aspect) : rowCamera(this.aspect);
  }

  /** The (damped) camera: aim, unit direction towards the camera, distance and the world height shown at the aim. */
  cameraState(): CameraPreset & { fov: number } {
    const s = this.camSprings;
    const length = Math.hypot(s[3].value, s[4].value, s[5].value) || 1;
    const preset: CameraPreset = {
      aim: [s[0].value, s[1].value, s[2].value],
      dir: [s[3].value / length, s[4].value / length, s[5].value / length],
      distance: s[6].value || 100,
      span: s[7].value || 20,
    };
    return { ...preset, fov: fovOf(preset) };
  }

  // ───────────────────────────── per-frame ─────────────────────────────

  update(dt: number) {
    dt = clamp(dt, 0, 0.05);
    const fast = this.instant;
    this.updateCamera(dt, fast);
    const rate = fast ? 40 : 7;
    if (this.layout === "ring") damp(this.ringPos, this.dragging ? this.ringPos.value : this.ringTarget, rate, dt);
    else damp(this.rowPos, this.dragging ? this.rowPos.value : this.rowTarget, rate, dt);
    damp(this.pull, this.layout === "ring" && this.detailOn ? 1 : 0, fast ? 40 : 5.5, dt);
    damp(this.morph, this.layout === "row" ? 1 : 0, fast ? 40 : 2.7, dt);

    this.advance(dt);
    if (this.swapping && this.pending !== null && !this.cards.some((card) => card.mode === "leave")) this.gather();
    if (!this.swapping && this.layout === "row") this.syncRowWindow();
    this.updateBusy();
    this.updateFins(dt);
    this.refreshSpots();
    this.compose(dt);
    const pullGoal = this.layout === "ring" && this.detailOn ? 1 : 0;
    const morphGoal = this.layout === "row" ? 1 : 0;
    const scrolling = this.layout === "ring" ? Math.abs(this.ringPos.value - this.ringTarget) > 0.002 : Math.abs(this.rowPos.value - this.rowTarget) > 0.002;
    const hovering = this.cards.some((card) => Math.abs(card.hover.velocity) > 0.001 || Math.abs(card.hover.value - (card.item === this.hoverItem && card.mode === "rest" ? 1 : 0)) > 0.002);
    const cameraMoving = this.camSprings.some((spring) => Math.abs(spring.velocity) > 0.01);
    const assembling = this.started && Math.abs(this.assemble.value - 1) > 0.002;
    const idling = this.ambient && this.layout === "ring" && this.started && this.presence > 0.01;
    this.animating =
      this.busy || this.loading || this.dragging || scrolling || hovering || cameraMoving || assembling || idling || this.presence < 1 || Math.abs(this.pull.value - pullGoal) > 0.002 || Math.abs(this.morph.value - morphGoal) > 0.002;
  }

  private updateCamera(dt: number, fast: boolean) {
    const goal = this.cameraGoal();
    const values = [goal.aim[0], goal.aim[1], goal.aim[2], goal.dir[0], goal.dir[1], goal.dir[2], goal.distance, goal.span];
    if (!this.camReady) {
      values.forEach((value, i) => {
        this.camSprings[i].value = value;
        this.camSprings[i].velocity = 0;
      });
      this.camReady = true;
      return;
    }
    const rate = fast ? 40 : 3.1;
    values.forEach((value, i) => damp(this.camSprings[i], value, rate, dt));
  }

  private advance(dt: number) {
    for (const card of this.cards) {
      if (card.mode === "away" || card.mode === "rest") continue;
      card.t += dt;
      if (card.t < card.duration) continue;
      if (card.mode === "fly") {
        card.mode = card.spare ? "away" : "rest";
        if (card.spare) this.release(card);
        else if (!this.fresh(card)) this.show(card, card.item);
      } else if (card.mode === "enter") {
        card.mode = "rest";
        if (!this.fresh(card) && card.item >= 0) this.show(card, card.item);
      }
      else if (card.mode === "leave") this.release(card);
    }
  }

  private updateBusy() {
    this.busy = this.swapping || this.cards.some((card) => card.mode === "fly" || card.mode === "enter" || card.mode === "leave");
  }

  /** The new cards of a category swap fly in from all around. */
  private gather() {
    const items = this.pending ?? [];
    this.pending = null;
    this.swapping = false;
    this.loading = false;
    this.items = items;
    this.selected = 0;
    this.rowPos.value = this.rowPos.velocity = 0;
    this.rowTarget = 0;
    this.cardOfItem.clear();
    const wanted = this.wanted("row", items.length, 0);
    wanted.forEach((item, order) => {
      const card = this.freeCard();
      if (card) this.enter(card, item, order, "gather");
    });
  }

  /** Cards exist only for the slots around the selected card; scrolling hands cards over from one end to the other. */
  private syncRowWindow() {
    const centre = Math.round(this.rowPos.value);
    const from = Math.max(0, centre - STAGE.before);
    const to = Math.min(this.items.length - 1, centre + STAGE.after);
    for (const [item, card] of this.cardOfItem) {
      if (item >= from && item <= to) continue;
      if (card.mode !== "rest") continue;
      this.cardOfItem.delete(item);
      this.release(card);
    }
    for (let item = from; item <= to; item++) {
      if (this.cardOfItem.has(item)) continue;
      const card = this.freeCard();
      if (!card) break;
      card.item = item;
      card.mode = "rest";
      card.spare = false;
      this.cardOfItem.set(item, card);
      this.show(card, item);
    }
  }

  private updateFins(dt: number) {
    if (this.ambient && this.layout === "ring") this.clock += dt;
    damp(this.assemble, this.started ? 1 : 0, this.instant ? 40 : 1.45, dt);
    const count = Math.max(1, this.items.length);
    const turn = this.layout === "ring" ? this.ringPos.value / count : this.finTurn;
    const shift = this.layout === "ring" ? turn : this.finTurn + (this.rowPos.value - this.finAnchor) / (TRACK.to - TRACK.from);
    this.fins.update({ turn, shift, morph: clamp(this.morph.value, 0, 1), clock: this.clock, presence: smooth(this.presence) * clamp(this.assemble.value, 0, 1) });
    this.fins.setVisible(this.started && this.presence > 0.002);
  }

  /** The pose a card would have at rest for its current item, in the current layout. */
  private restPose(card: Card, out: Pose) {
    const frame = scratch.frame;
    if (this.layout === "ring") {
      const count = Math.max(1, this.items.length);
      const slot = wrapSigned(card.item - this.ringPos.value, count);
      this.bandPose(slot, count, out);
      // The archive at the focus is drawn out of the band into the opening of the left loop; the ones beside it follow a little.
      const present = smooth(1 - Math.abs(slot));
      if (present > 0.001) this.placeToward(out, this.holeSpot, present, RING_CARD.arc);
      const weight = this.pull.value * present;
      if (weight > 0.001) this.placeToward(out, this.detailSpot, weight, 0);
    } else {
      const slot = card.item - this.rowPos.value;
      const clamped = clamp(slot, ROW.firstSlot - 1, ROW.lastSlot + 1);
      rowFrame(clamped, frame);
      this.fromFrame(frame, out);
      // Cards slide in and out at the two ends of the track by growing/shrinking, not by popping.
      const left = smooth((slot - ROW.firstSlot) / 1.4);
      const right = 1 - smooth((slot - (ROW.lastSlot - 1.4)) / 1.4);
      out.scale = Math.min(left, right);
      const weight = smooth(1 - Math.abs(slot));
      if (weight > 0.001) this.placeToward(out, this.detailSpot, weight, 0);
    }
  }

  /** A card on the band: the plate at its lap fraction, turned over once per lap so that it is upright at the focus. */
  private bandPose(slot: number, count: number, out: Pose) {
    const lap = BAND.focus + slot / Math.max(1, count);
    const plate = turnPlate(plateAt(this.bandPath, lap, this.clock, this.plate), lapFlip(lap));
    out.pos.set(plate.p[0], plate.p[1], plate.p[2]);
    scratch.basis.makeBasis(scratch.a.set(plate.x[0], plate.x[1], plate.x[2]), scratch.b.set(plate.y[0], plate.y[1], plate.y[2]), scratch.c.set(plate.z[0], plate.z[1], plate.z[2]));
    out.quat.setFromRotationMatrix(scratch.basis);
    out.scale = RING_CARD.scale;
  }

  private fromFrame(frame: RingFrame, out: Pose) {
    out.pos.set(frame.point[0], frame.point[1], frame.point[2]);
    scratch.basis.makeBasis(scratch.a.set(frame.tangent[0], frame.tangent[1], frame.tangent[2]), scratch.b.set(frame.width[0], frame.width[1], frame.width[2]), new THREE.Vector3(frame.normal[0], frame.normal[1], frame.normal[2]));
    out.quat.setFromRotationMatrix(scratch.basis);
  }

  /** Blend `pose` towards `spot` (a place in front of the camera); `arc` bows the way there towards the viewer so it clears the band. */
  private placeToward(pose: Pose, spot: Pose, weight: number, arc: number) {
    pose.pos.lerp(spot.pos, weight);
    if (arc > 0) pose.pos.addScaledVector(this.towardEye, Math.sin(Math.PI * weight) * arc);
    pose.quat.slerp(spot.quat, weight);
    pose.scale += (spot.scale - pose.scale) * weight;
  }

  /** The two places a pulled-out card can hang this frame, from the (damped) camera: the loop's opening and the left of the screen. */
  private refreshSpots() {
    const camera = this.cameraState();
    this.towardEye.set(camera.dir[0], camera.dir[1], camera.dir[2]);
    this.spotOf(holePlacement(camera, this.aspect), this.holeSpot);
    this.spotOf(detailPlacement(camera, this.aspect), this.detailSpot);
  }

  private spotOf(placement: DetailPlacement, out: Pose) {
    out.pos.set(placement.position[0], placement.position[1], placement.position[2]);
    scratch.basis.makeBasis(scratch.a.set(placement.right[0], placement.right[1], placement.right[2]), scratch.b.set(placement.up[0], placement.up[1], placement.up[2]), scratch.c.set(placement.normal[0], placement.normal[1], placement.normal[2]));
    out.quat.setFromRotationMatrix(scratch.basis);
    out.scale = placement.scale;
  }

  private applyOffset(pose: Pose, offset: Offset) {
    pose.pos.x += offset.x;
    pose.pos.y += offset.y;
    pose.pos.z += offset.z;
    scratch.euler.set(offset.pitch, offset.yaw, offset.roll, "YXZ");
    scratch.q.setFromEuler(scratch.euler);
    pose.quat.multiply(scratch.q);
    pose.scale *= offset.scale;
  }

  /** Poses of all cards, their matrices, faces and the detail/hover overlays for this frame. */
  private compose(dt: number) {
    const target = scratch.target;
    let drawn = 0;
    const lift = (1 - smooth(this.presence)) * 34;
    let detailCard: Card | undefined;
    let detailWeight = 0;
    for (const card of this.cards) {
      card.drawn = false;
      if (card.mode === "away") continue;
      const pose = card.pose;
      if (card.mode === "rest") {
        this.restPose(card, pose);
      } else if (card.mode === "fly") {
        this.restPose(card, target);
        if (card.spare) target.scale = 0;
        const p = clamp(card.t / card.duration, 0, 1);
        if (card.t < 0) pose.copy(card.from);
        else {
          const e = flightEase(p);
          const f = flightOffset(p, card.seed);
          pose.pos.lerpVectors(card.from.pos, target.pos, e);
          pose.pos.x += f.x;
          pose.pos.y += f.y;
          pose.pos.z += f.z;
          pose.quat.copy(card.from.quat).slerp(target.quat, e);
          scratch.q2.setFromAxisAngle(scratch.axisY, f.spin);
          pose.quat.multiply(scratch.q2);
          pose.scale = (card.from.scale + (target.scale - card.from.scale) * e) * f.pop;
          // Half-way round, the card faces away: that is when its face changes.
          if (f.turn >= 0.5 && !card.spare && !this.fresh(card)) this.show(card, card.item);
        }
      } else if (card.mode === "enter") {
        if (card.t < 0) {
          pose.scale = 0;
        } else {
          this.restPose(card, pose);
          const offset = enterOffset(card.style, clamp(card.t / card.duration, 0, 1), card.seed, scratch.offset);
          this.applyOffset(pose, offset);
        }
      } else if (card.mode === "leave") {
        pose.copy(card.from);
        if (card.t > 0) this.applyOffset(pose, exitOffset(card.style, clamp(card.t / card.duration, 0, 1), card.seed, card.side, scratch.offset));
      }
      if (lift > 0.01) pose.pos.y -= lift;

      // Hover: the card steps out towards the viewer along its normal.
      const wantHover = card.item === this.hoverItem && card.mode === "rest" ? 1 : 0;
      damp(card.hover, wantHover, this.instant ? 40 : 12, dt);
      const hover = clamp(card.hover.value, 0, 1.2);
      const scale = pose.scale * (1 + 0.05 * hover);
      if (scale < 0.02 || (card.mode === "enter" && card.t < 0)) continue;
      scratch.a.set(0, 0, 1).applyQuaternion(pose.quat);
      const px = pose.pos.x + scratch.a.x * 0.55 * hover;
      const py = pose.pos.y + scratch.a.y * 0.55 * hover;
      const pz = pose.pos.z + scratch.a.z * 0.55 * hover;
      // Origin of the cassette: its local centre is (0, mid, midZ), so move back from the centre point.
      scratch.b.set(0, CARD.mid * scale, CARD.midZ * scale).applyQuaternion(pose.quat);
      card.matrix.compose(scratch.hit.set(px - scratch.b.x, py - scratch.b.y, pz - scratch.b.z), pose.quat, scratch.a.set(scale, scale, scale));
      card.matrix.toArray(this.matrices, drawn * 16);
      this.distances[drawn] = this.layout === "ring" ? Math.abs(wrapSigned(card.item - this.ringPos.value, Math.max(1, this.items.length))) : Math.abs(card.item - this.rowPos.value);
      drawn++;
      card.drawn = true;

      const pull = this.layout === "row" ? smooth(1 - Math.abs(card.item - this.rowPos.value)) : this.pull.value * smooth(1 - Math.abs(wrapSigned(card.item - this.ringPos.value, Math.max(1, this.items.length))));
      if (pull > detailWeight && card.mode === "rest") {
        detailWeight = pull;
        detailCard = card;
      }
    }
    this.count = drawn;
    this.composeFaces(detailCard, detailWeight);
    const front = detailCard ?? this.cards.find((card) => card.drawn && card.item === this.selected);
    if (front) this.focus.copy(front.pose.pos);
  }

  private composeFaces(detailCard: Card | undefined, detailWeight: number) {
    const detailShown = detailCard ? smooth((detailWeight - 0.55) / 0.4) : 0;
    const wantDetail = detailCard && detailShown > 0.01 ? detailCard.item : -1;
    if (wantDetail !== this.detailItem) {
      this.detailItem = wantDetail;
      if (wantDetail >= 0) this.paintDetail();
    } else if (wantDetail >= 0) this.paintDetail();

    const presence = smooth(this.presence);
    for (const card of this.cards) {
      const face = card.face;
      if (!face) continue;
      if (!card.drawn) {
        face.mesh.visible = false;
        continue;
      }
      const isDetail = card === detailCard && detailShown > 0.01;
      face.mesh.matrix.copy(card.matrix);
      face.mesh.matrixWorldNeedsUpdate = true;
      face.mesh.visible = true;
      face.material.opacity = (isDetail ? 1 - detailShown : 1) * presence * clamp(card.pose.scale * 1.6, 0, 1);
      if (face.material.opacity < 0.01) face.mesh.visible = false;
    }
    const detailOwner = detailCard && detailShown > 0.01 ? detailCard : undefined;
    this.detailFace.mesh.visible = Boolean(detailOwner);
    if (detailOwner) {
      this.detailFace.mesh.matrix.copy(detailOwner.matrix);
      this.detailFace.mesh.matrixWorldNeedsUpdate = true;
      this.detailFace.material.opacity = detailShown * presence;
    }
    const hoverCard = this.hoverItem >= 0 ? this.cardOfItem.get(this.hoverItem) : undefined;
    const hoverShown = hoverCard && hoverCard.drawn && hoverCard !== detailOwner ? clamp((hoverCard.hover.value - 0.35) / 0.5, 0, 1) : 0;
    this.infoFace.mesh.visible = hoverShown > 0.01;
    if (hoverCard && hoverShown > 0.01) {
      this.infoFace.mesh.matrix.copy(hoverCard.matrix);
      this.infoFace.mesh.matrixWorldNeedsUpdate = true;
      this.infoFace.material.opacity = hoverShown * presence;
    }
  }

  // ───────────────────────────── debugging ─────────────────────────────

  describe() {
    const modes: Record<string, number> = {};
    for (const card of this.cards) modes[card.mode] = (modes[card.mode] ?? 0) + 1;
    return {
      layout: this.layout,
      items: this.items.length,
      selected: this.selected,
      cards: this.cards.length,
      drawn: this.count,
      modes,
      busy: this.busy,
      loading: this.loading,
      swapping: this.swapping,
      morph: Number(this.morph.value.toFixed(3)),
      ringPos: Number(this.ringPos.value.toFixed(3)),
      rowPos: Number(this.rowPos.value.toFixed(3)),
      pull: Number(this.pull.value.toFixed(3)),
      detail: this.detailItem,
    };
  }

  dispose() {
    for (const card of this.cards) card.face?.dispose();
    this.infoFace.dispose();
    this.detailFace.dispose();
    this.faceGeometry.dispose();
    this.fins.dispose();
    this.group.removeFromParent();
  }
}
