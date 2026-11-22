import * as THREE from "three";
import { DISC_RADIUS, discGeometry, discTurn, discZone, hitPlate, layoutGroups, plateHeight, railScale, turnDelta, type DiscGeometry, type PlateGroup, type PlateSpec, type Rect, type Viewport } from "./rail/model";
import { DISC_TICKS, paintDisc, paintDiscRing, paintPlate, RAIL_DARK, RAIL_LIGHT, type RailPalette } from "./rail/paint";
import { softShadow } from "./rail/shadow";

/**
 * The control rail: the plates (index tabs) and the music disc that replace buttons drawn in HTML.
 *
 * It is its own small three.js scene on a transparent canvas that lies over the main canvas, so it stays crisp and is not
 * blurred or darkened by the depth of field and ambient occlusion of the archive scene, and it is drawn only when something
 * on it moves. Everything is in CSS pixels: the camera is set so that the plane z = 0 maps one to one onto the screen.
 * Plates and the disc are hit-tested in 2D (see rail/model.ts) and animate in 3D: a plate lifts and leans towards the
 * pointer when it is hovered and sinks when pressed; the disc turns while a song plays.
 */

export type DiscAction = { type: "toggle" } | { type: "seek"; turn: number } | { type: "volume"; direction: number };

export interface RailEvents {
  press(id: string, cell?: number): void;
  slide(id: string, amount: number): void;
  wheel(id: string, direction: number): void;
  field(id: string, text: string): void;
  submit(id: string): void;
  focus(id: string | null): void;
  disc(action: DiscAction): void;
}

export interface DiscSpec {
  /** The song's cover once it has arrived (null: the plain label). */
  cover: CanvasImageSource | null;
  /** True before anything has been chosen. */
  empty: boolean;
  playing: boolean;
  /** 0…1 along the song, or null when its length is not known. */
  progress: number | null;
  /** 0…1 loudness: the ticks and the plates of the ring breathe with it. */
  level: number;
  /** The big disc of the music view, or the small one of the other views. */
  big: boolean;
}

interface PlateView {
  spec: PlateSpec;
  key: string;
  rect: Rect;
  group: THREE.Group;
  face: THREE.Mesh;
  body: THREE.Mesh;
  shadow: THREE.Mesh;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  /** Springs, each 0…1. */
  hover: number;
  press: number;
  appear: number;
  /** Cell of a `segments` plate that the pointer is over. */
  cell: number | null;
  dead: boolean;
}

const FOV = 28;
const DEPTH = 6;
const MAX_DPR = 2;
const ease = (amount: number) => amount * amount * (3 - 2 * amount);
const follow = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

function keyOf(spec: PlateSpec, dark: boolean, caret: boolean): string {
  return JSON.stringify([spec.kind, spec.label, spec.value, spec.active, spec.disabled, spec.options, spec.selected, spec.amount === undefined ? undefined : Math.round(spec.amount * 100), spec.text, spec.placeholder, spec.focused, spec.width, spec.height, dark, spec.focused ? caret : false]);
}

export class ControlRail {
  readonly canvas: HTMLCanvasElement;
  events: Partial<RailEvents> = {};

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10);
  private readonly views = new Map<string, PlateView>();
  private groups: PlateGroup[] = [];
  private rects = new Map<string, Rect>();
  private view: Viewport = { width: 1, height: 1 };
  private scale = 1;
  private dpr = 1;
  private dark = false;
  private dirty = true;
  private clock = 0;
  private lastCaret = true;
  private disposed = false;
  private readonly abort = new AbortController();
  private readonly shadowTexture: THREE.CanvasTexture;
  private readonly bodyColor = new THREE.Color();
  private pointer = { x: -9999, y: -9999, inside: false };
  private pressed?: { id: string; cell?: number; slide: boolean };
  private hovered?: { id: string; cell?: number };
  private input?: HTMLInputElement;
  private inputFor?: string;

  // The disc.
  private disc?: DiscSpec;
  private discSpin = 0;
  private discBig = 0;
  private discHover = 0;
  private discPress = 0;
  private discAppear = 0;
  private discGhost: number | null = null;
  private discDrag?: { start: number; moved: boolean };
  private discGroup?: THREE.Group;
  private discMesh?: THREE.Mesh;
  private discFace?: THREE.CanvasTexture;
  private discFaceCanvas?: HTMLCanvasElement;
  private ringMesh?: THREE.Mesh;
  private ringTexture?: THREE.CanvasTexture;
  private ringCanvas?: HTMLCanvasElement;
  private discShadow?: THREE.Mesh;
  private ringKey = "";
  private faceKey = "";
  private current: DiscGeometry = { cx: 0, cy: 0, radius: 0 };

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.canvas = this.renderer.domElement;
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "2" });
    this.canvas.setAttribute("aria-hidden", "true");
    container.appendChild(this.canvas);
    this.shadowTexture = softShadow();
    this.canvas.addEventListener("webglcontextlost", (event) => event.preventDefault(), { signal: this.abort.signal });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.repaintAll();
      this.dirty = true;
    }, { signal: this.abort.signal });
    this.resize();
  }

  // ------------------------------------------------------------------------------------------ what is on the rail

  setGroups(groups: PlateGroup[]) {
    this.groups = groups;
    const seen = new Set<string>();
    for (const group of groups) {
      for (const spec of group.plates) {
        seen.add(spec.id);
        let view = this.views.get(spec.id);
        if (!view) {
          view = this.makeView(spec);
          this.views.set(spec.id, view);
        }
        view.dead = false;
        view.spec = spec;
      }
    }
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        view.dead = true;
        if (this.inputFor === id) this.blurField();
      }
    }
    this.relayout();
    this.dirty = true;
  }

  /** The disc, or null to hide it. */
  setDisc(spec: DiscSpec | null) {
    this.disc = spec ?? undefined;
    this.dirty = true;
    if (spec && !this.discGroup) this.buildDisc();
  }

  setDark(dark: boolean) {
    if (dark === this.dark) return;
    this.dark = dark;
    this.faceKey = "";
    this.ringKey = "";
    this.dirty = true;
  }

  /** Fonts that arrived late: print everything again. */
  repaintAll() {
    for (const view of this.views.values()) view.key = "";
    this.faceKey = "";
    this.ringKey = "";
    this.dirty = true;
  }

  get palette(): RailPalette {
    return this.dark ? RAIL_DARK : RAIL_LIGHT;
  }

  /** True when the pointer is over a plate or the disc (so that the archive stage does not take the press). */
  get over(): boolean {
    return Boolean(this.hovered) || this.discOver();
  }

  get busy(): boolean {
    return Boolean(this.pressed) || Boolean(this.discDrag);
  }

  /** What the rail would draw this moment, for the debug hook and the tests. */
  describe() {
    return {
      plates: [...this.views.values()].filter((view) => !view.dead).map((view) => ({ id: view.spec.id, rect: view.rect, hover: Number(view.hover.toFixed(2)) })),
      disc: this.disc ? { ...this.current, big: Number(this.discBig.toFixed(2)), spin: Number(this.discSpin.toFixed(2)) } : null,
      scale: this.scale,
    };
  }

  // ------------------------------------------------------------------------------------------ size

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(width, height, false);
    this.view = { width, height };
    this.scale = railScale(this.view);
    const distance = height / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this.camera.aspect = width / height;
    this.camera.near = distance * 0.2;
    this.camera.far = distance * 4;
    this.camera.position.set(0, 0, distance);
    this.camera.updateProjectionMatrix();
    this.relayout();
    this.faceKey = "";
    this.ringKey = "";
    for (const view of this.views.values()) view.key = "";
    this.dirty = true;
  }

  private relayout() {
    this.rects = layoutGroups(this.groups, this.view, this.scale);
    for (const [id, view] of this.views) {
      const rect = this.rects.get(id);
      if (rect) view.rect = rect;
    }
  }

  // ------------------------------------------------------------------------------------------ building

  private makeView(spec: PlateSpec): PlateView {
    const canvas = document.createElement("canvas");
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const unit = new THREE.PlaneGeometry(1, 1);
    const face = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false }));
    const body = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, color: 0x30343a, depthWrite: false }));
    const shadow = new THREE.Mesh(unit, new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, opacity: 0.32, toneMapped: false, depthWrite: false }));
    face.renderOrder = 3;
    body.renderOrder = 2;
    shadow.renderOrder = 1;
    const group = new THREE.Group();
    group.add(shadow, body, face);
    this.scene.add(group);
    return { spec, key: "", rect: this.rects.get(spec.id) ?? { x: 0, y: 0, w: spec.width, h: plateHeight(spec) }, group, face, body, shadow, canvas, texture, hover: 0, press: 0, appear: 0, cell: null, dead: false };
  }

  private print(view: PlateView, caret: boolean) {
    const key = keyOf(view.spec, this.dark, caret) + `|${view.rect.w}x${view.rect.h}|${this.dpr}`;
    if (key === view.key) return;
    view.key = key;
    const w = Math.max(1, Math.round(view.rect.w));
    const h = Math.max(1, Math.round(view.rect.h));
    const pixel = this.dpr;
    view.canvas.width = Math.ceil(w * pixel);
    view.canvas.height = Math.ceil(h * pixel);
    const ctx = view.canvas.getContext("2d")!;
    ctx.setTransform(pixel, 0, 0, pixel, 0, 0);
    // The plate is printed at its logical size at scale 1 and stretched to the scaled rectangle, so one layout serves all sizes.
    const logicalW = view.spec.width;
    const logicalH = plateHeight(view.spec);
    ctx.scale(w / logicalW, h / logicalH);
    paintPlate(ctx, view.spec, logicalW, logicalH, this.palette, { caret });
    view.texture.needsUpdate = true;
  }

  private buildDisc() {
    const size = 384;
    this.discFaceCanvas = document.createElement("canvas");
    this.discFaceCanvas.width = this.discFaceCanvas.height = size;
    this.discFace = new THREE.CanvasTexture(this.discFaceCanvas);
    this.discFace.colorSpace = THREE.SRGBColorSpace;
    this.discFace.anisotropy = 4;
    this.ringCanvas = document.createElement("canvas");
    this.ringCanvas.width = this.ringCanvas.height = 640;
    this.ringTexture = new THREE.CanvasTexture(this.ringCanvas);
    this.ringTexture.colorSpace = THREE.SRGBColorSpace;

    const radius = DISC_RADIUS.big;
    const thickness = 7;
    const geometry = new THREE.CylinderGeometry(radius, radius, thickness, 72, 1);
    geometry.rotateX(Math.PI / 2); // axis along z: the caps face the viewer
    const side = new THREE.MeshBasicMaterial({ color: 0x0d0f10, toneMapped: false });
    const top = new THREE.MeshBasicMaterial({ map: this.discFace, toneMapped: false });
    const back = new THREE.MeshBasicMaterial({ color: 0x101213, toneMapped: false });
    this.discMesh = new THREE.Mesh(geometry, [side, top, back]);
    this.discMesh.renderOrder = 5;

    const ring = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2 * 1.3, radius * 2 * 1.3), new THREE.MeshBasicMaterial({ map: this.ringTexture, transparent: true, toneMapped: false, depthWrite: false }));
    ring.position.z = thickness / 2 + 1;
    ring.renderOrder = 6;
    this.ringMesh = ring;

    this.discShadow = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2 * 1.5, radius * 2 * 1.5), new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, opacity: 0.4, toneMapped: false, depthWrite: false }));
    this.discShadow.position.set(6, -12, -radius * 0.5);
    this.discShadow.renderOrder = 4;

    this.discGroup = new THREE.Group();
    this.discGroup.add(this.discShadow, this.discMesh, ring);
    this.scene.add(this.discGroup);
  }

  // ------------------------------------------------------------------------------------------ the frame

  /** Advance the animation by `dt` seconds and draw if anything changed. */
  update(dt: number, time: number) {
    if (this.disposed) return;
    dt = Math.min(dt, 0.1);
    this.clock = time;
    const caret = Math.floor(time * 2) % 2 === 0;
    if (this.inputFor && caret !== this.lastCaret) {
      this.lastCaret = caret;
      this.dirty = true;
    }
    let moving = false;
    const dead: string[] = [];
    for (const [id, view] of this.views) {
      const hoverTarget = this.hovered?.id === id && !view.spec.disabled ? 1 : 0;
      const pressTarget = this.pressed?.id === id ? 1 : 0;
      const appearTarget = view.dead ? 0 : 1;
      const before = view.hover + view.press * 3 + view.appear * 7;
      view.hover = follow(view.hover, hoverTarget, 16, dt);
      view.press = follow(view.press, pressTarget, 30, dt);
      view.appear = follow(view.appear, appearTarget, view.dead ? 18 : 9, dt);
      if (Math.abs(view.hover - hoverTarget) < 0.002) view.hover = hoverTarget;
      if (Math.abs(view.press - pressTarget) < 0.002) view.press = pressTarget;
      if (Math.abs(view.appear - appearTarget) < 0.002) view.appear = appearTarget;
      if (view.dead && view.appear === 0) dead.push(id);
      else {
        if (before !== view.hover + view.press * 3 + view.appear * 7) moving = true;
        if (view.hover !== hoverTarget || view.press !== pressTarget || view.appear !== appearTarget) moving = true;
        this.print(view, view.spec.focused ? caret : false);
        this.pose(view);
      }
    }
    for (const id of dead) {
      const view = this.views.get(id)!;
      this.scene.remove(view.group);
      view.texture.dispose();
      (view.face.material as THREE.Material).dispose();
      (view.body.material as THREE.Material).dispose();
      (view.shadow.material as THREE.Material).dispose();
      this.views.delete(id);
      this.dirty = true;
    }
    if (this.updateDisc(dt)) moving = true;
    if (moving || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  private pose(view: PlateView) {
    const { rect } = view;
    const lift = Math.sin(view.appear * Math.PI * 0.5);
    const hover = ease(view.hover);
    const x = rect.x + rect.w / 2;
    // A new plate slides up into its place; a plate that goes away sinks back and fades.
    const y = rect.y + rect.h / 2 + (1 - ease(view.appear)) * 26 * this.scale;
    const group = view.group;
    group.position.set(x - this.view.width / 2, this.view.height / 2 - y, 0);
    const pointerX = this.pointer.inside && this.hovered?.id === view.spec.id ? THREE.MathUtils.clamp((this.pointer.x - x) / (rect.w / 2), -1, 1) : 0;
    const pointerY = this.pointer.inside && this.hovered?.id === view.spec.id ? THREE.MathUtils.clamp((this.pointer.y - (rect.y + rect.h / 2)) / (rect.h / 2), -1, 1) : 0;
    // At rest the plates lean back a little, like tabs standing in a rack; the hovered one stands up and turns towards the pointer.
    group.rotation.x = THREE.MathUtils.degToRad(14) * (1 - hover) + pointerY * 0.12 * hover - view.press * 0.06;
    group.rotation.y = pointerX * 0.16 * hover;
    group.position.z = hover * 16 * this.scale - view.press * 8 * this.scale;
    group.scale.setScalar(0.92 + 0.08 * lift + hover * 0.035 - view.press * 0.02);
    view.face.scale.set(rect.w, rect.h, 1);
    view.body.scale.set(rect.w, rect.h, 1);
    view.body.position.set(0, -1.5, -DEPTH * this.scale);
    view.shadow.scale.set(rect.w * 1.14, rect.h * 1.5, 1);
    view.shadow.position.set(3, -9 * this.scale - hover * 8, -DEPTH * 2.4 * this.scale - hover * 10);
    (view.face.material as THREE.MeshBasicMaterial).opacity = lift;
    (view.body.material as THREE.MeshBasicMaterial).opacity = lift;
    (view.shadow.material as THREE.MeshBasicMaterial).opacity = 0.34 * lift * (1 - hover * 0.35);
    const tint = 0.97 + 0.03 * hover;
    (view.face.material as THREE.MeshBasicMaterial).color.setScalar(tint);
    view.face.visible = view.body.visible = view.shadow.visible = lift > 0.001;
  }

  private updateDisc(dt: number): boolean {
    const group = this.discGroup;
    const spec = this.disc;
    if (!group) return false;
    const appearTarget = spec ? 1 : 0;
    this.discAppear = follow(this.discAppear, appearTarget, 8, dt);
    if (Math.abs(this.discAppear - appearTarget) < 0.002) this.discAppear = appearTarget;
    group.visible = this.discAppear > 0.001;
    if (!spec && this.discAppear === 0) return false;
    let moving = this.discAppear !== appearTarget;
    const bigTarget = spec?.big ? 1 : 0;
    const before = this.discBig + this.discHover + this.discPress;
    this.discBig = follow(this.discBig, bigTarget, 7, dt);
    if (Math.abs(this.discBig - bigTarget) < 0.002) this.discBig = bigTarget;
    const hoverTarget = this.discOver() ? 1 : 0;
    this.discHover = follow(this.discHover, hoverTarget, 14, dt);
    this.discPress = follow(this.discPress, this.discDrag || (this.pressed?.id === "$disc") ? 1 : 0, 24, dt);
    if (before !== this.discBig + this.discHover + this.discPress) moving = true;

    // Where it is and how large: between the small and the big disc.
    const small = discGeometry(this.view, false, this.scale);
    const large = discGeometry(this.view, true, this.scale);
    const k = ease(this.discBig);
    this.current = {
      cx: THREE.MathUtils.lerp(small.cx, large.cx, k),
      cy: THREE.MathUtils.lerp(small.cy, large.cy, k),
      radius: THREE.MathUtils.lerp(small.radius, large.radius, k),
    };
    const rise = ease(this.discAppear);
    const size = (this.current.radius / DISC_RADIUS.big) * (0.8 + 0.2 * rise) * (1 + this.discHover * 0.04 - this.discPress * 0.03);
    group.scale.setScalar(size);
    group.position.set(this.current.cx - this.view.width / 2, this.view.height / 2 - this.current.cy - (1 - rise) * 24, 0);
    group.rotation.x = -THREE.MathUtils.degToRad(26) * (1 - this.discHover * 0.5);
    const lean = this.pointer.inside ? THREE.MathUtils.clamp((this.pointer.x - this.current.cx) / (this.current.radius * 4), -1, 1) : 0;
    group.rotation.y = lean * 0.2 * this.discHover;
    (this.discMesh!.material as THREE.MeshBasicMaterial[]).forEach((material) => {
      material.opacity = rise;
      material.transparent = rise < 1;
    });

    // The turning: a song's disc spins at 33⅓ r/min in spirit (a little slower so that the cover stays readable); a pause lets it coast to a stop.
    const speed = spec?.playing ? 1 : 0;
    this.discSpeed = follow(this.discSpeed, speed, spec?.playing ? 3 : 1.6, dt);
    if (this.discSpeed < 0.002 && !spec?.playing) this.discSpeed = 0;
    else moving = true;
    this.discSpin += dt * this.discSpeed * 1.3 * (1 + (spec?.level ?? 0) * 0.5);
    this.discMesh!.rotation.z = -this.discSpin;

    if (spec) this.printDisc(spec);
    return moving;
  }

  private discSpeed = 0;

  private printDisc(spec: DiscSpec) {
    const faceKey = `${this.dark}|${spec.empty}|${spec.cover ? "c" : "-"}|${this.coverId(spec.cover)}`;
    if (faceKey !== this.faceKey) {
      this.faceKey = faceKey;
      paintDisc(this.discFaceCanvas!.getContext("2d")!, this.discFaceCanvas!.width, this.palette, spec.cover, spec.empty);
      this.discFace!.needsUpdate = true;
    }
    const ticks = spec.progress === null ? -1 : Math.floor(Math.min(0.9999, Math.max(0, spec.progress)) * DISC_TICKS);
    const ghost = this.discGhost === null ? -1 : Math.floor(this.discGhost * DISC_TICKS);
    const ringKey = `${this.dark}|${ticks}|${ghost}|${spec.progress === null}`;
    if (ringKey !== this.ringKey) {
      this.ringKey = ringKey;
      // The canvas shows the disc of radius R in the middle of a square of 1.3 × 2R; the painter wants the radius in canvas pixels.
      const canvasSize = this.ringCanvas!.width;
      paintDiscRing(this.ringCanvas!.getContext("2d")!, canvasSize, (canvasSize / 1.3 / 2), spec.progress, this.discGhost, this.palette, spec.progress === null);
      this.ringTexture!.needsUpdate = true;
      this.dirty = true;
    }
  }

  private covers = new WeakMap<object, number>();
  private coverCount = 0;
  private coverId(cover: CanvasImageSource | null): number {
    if (!cover) return 0;
    let id = this.covers.get(cover as object);
    if (!id) this.covers.set(cover as object, (id = ++this.coverCount));
    return id;
  }

  // ------------------------------------------------------------------------------------------ pointer

  private local(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ((clientX - rect.left) / Math.max(1, rect.width)) * this.view.width, y: ((clientY - rect.top) / Math.max(1, rect.height)) * this.view.height };
  }

  private discOver(): boolean {
    if (!this.disc || this.discAppear < 0.5 || !this.pointer.inside) return false;
    return discZone(this.current, this.pointer.x, this.pointer.y) !== "outside";
  }

  /** The pointer moved (client coordinates). Returns true when it is over the rail. */
  move(clientX: number, clientY: number): boolean {
    const { x, y } = this.local(clientX, clientY);
    this.pointer = { x, y, inside: true };
    this.dirty = true;
    if (this.pressed?.slide) {
      const rect = this.rects.get(this.pressed.id);
      if (rect) this.events.slide?.(this.pressed.id, Math.min(1, Math.max(0, (x - rect.x - 14) / Math.max(1, rect.w - 28))));
      return true;
    }
    if (this.discDrag) {
      const turn = discTurn(this.current, x, y);
      if (Math.abs(turnDelta(this.discDrag.start, turn)) > 0.004) this.discDrag.moved = true;
      this.setGhost(turn);
      return true;
    }
    const hit = hitPlate(this.groups, this.rects, x, y);
    const over = this.disc && !hit ? discZone(this.current, x, y) : "outside";
    this.hovered = hit ? { id: hit.id, cell: hit.cell } : undefined;
    for (const view of this.views.values()) view.cell = view.spec.id === hit?.id ? (hit.cell ?? null) : null;
    this.setGhost(over === "rim" ? discTurn(this.current, x, y) : null);
    return Boolean(hit) || over !== "outside";
  }

  private setGhost(turn: number | null) {
    if (turn === this.discGhost) return;
    const before = this.discGhost === null ? -1 : Math.floor(this.discGhost * DISC_TICKS);
    const after = turn === null ? -1 : Math.floor(turn * DISC_TICKS);
    this.discGhost = turn;
    if (before !== after) this.dirty = true;
  }

  leave() {
    this.pointer.inside = false;
    this.hovered = undefined;
    this.setGhost(null);
    if (!this.pressed && !this.discDrag) this.dirty = true;
  }

  /** A press (client coordinates). Returns true when the rail takes it. */
  down(clientX: number, clientY: number): boolean {
    const { x, y } = this.local(clientX, clientY);
    this.pointer = { x, y, inside: true };
    const hit = hitPlate(this.groups, this.rects, x, y);
    if (hit) {
      const spec = this.views.get(hit.id)?.spec;
      this.pressed = { id: hit.id, cell: hit.cell, slide: spec?.kind === "slider" };
      if (spec?.kind === "slider") {
        const rect = this.rects.get(hit.id)!;
        this.events.slide?.(hit.id, Math.min(1, Math.max(0, (x - rect.x - 14) / Math.max(1, rect.w - 28))));
      }
      this.dirty = true;
      return true;
    }
    if (this.disc && this.discAppear > 0.5) {
      const zone = discZone(this.current, x, y);
      if (zone === "rim") {
        this.discDrag = { start: discTurn(this.current, x, y), moved: false };
        this.setGhost(this.discDrag.start);
        this.dirty = true;
        return true;
      }
      if (zone === "label") {
        this.pressed = { id: "$disc", slide: false };
        this.dirty = true;
        return true;
      }
    }
    return false;
  }

  /** The release of a press the rail took. Returns true when it was one. */
  up(clientX: number, clientY: number, cancelled = false): boolean {
    const { x, y } = this.local(clientX, clientY);
    this.dirty = true;
    if (this.discDrag) {
      const drag = this.discDrag;
      this.discDrag = undefined;
      const turn = discTurn(this.current, x, y);
      this.setGhost(null);
      if (!cancelled) this.events.disc?.({ type: "seek", turn: drag.moved ? turn : drag.start });
      return true;
    }
    const pressed = this.pressed;
    if (!pressed) return false;
    this.pressed = undefined;
    if (cancelled) return true;
    if (pressed.id === "$disc") {
      if (discZone(this.current, x, y) === "label") this.events.disc?.({ type: "toggle" });
      return true;
    }
    const hit = hitPlate(this.groups, this.rects, x, y);
    if (!hit || hit.id !== pressed.id) return true;
    const spec = this.views.get(hit.id)?.spec;
    if (spec?.kind === "field") this.focusField(hit.id);
    else if (spec?.kind === "tab" || spec?.kind === "segments") this.events.press?.(hit.id, hit.cell);
    return true;
  }

  /** The wheel over the rail (client coordinates). Returns true when it was used. */
  wheel(clientX: number, clientY: number, deltaY: number): boolean {
    const { x, y } = this.local(clientX, clientY);
    const hit = hitPlate(this.groups, this.rects, x, y);
    const direction = deltaY > 0 ? -1 : 1; // wheel up raises a value
    if (hit) {
      const spec = this.views.get(hit.id)?.spec;
      if (spec?.kind === "slider" || spec?.kind === "segments") {
        this.events.wheel?.(hit.id, direction);
        return true;
      }
      return false;
    }
    if (this.disc && this.discAppear > 0.5 && discZone(this.current, x, y) !== "outside") {
      this.events.disc?.({ type: "volume", direction });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------ the text field

  /** Give the keyboard to the field plate `id`: an invisible input sits where the plate is, so that IME windows open there. */
  focusField(id: string) {
    const view = this.views.get(id);
    if (!view) return;
    const input = (this.input ??= this.makeInput());
    this.inputFor = id;
    input.value = view.spec.text ?? "";
    const rect = view.rect;
    Object.assign(input.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    input.focus({ preventScroll: true });
    this.events.focus?.(id);
    this.dirty = true;
  }

  blurField() {
    if (!this.input || !this.inputFor) return;
    const id = this.inputFor;
    this.inputFor = undefined;
    this.input.blur();
    this.events.focus?.(null);
    void id;
    this.dirty = true;
  }

  get typing(): string | undefined {
    return this.inputFor;
  }

  private makeInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "搜索");
    input.maxLength = 100;
    Object.assign(input.style, { position: "absolute", opacity: "0", pointerEvents: "none", zIndex: "1", border: "0", padding: "0", margin: "0", background: "transparent", color: "transparent", caretColor: "transparent", font: "16px sans-serif" });
    const { signal } = this.abort;
    input.addEventListener("input", () => {
      if (this.inputFor) this.events.field?.(this.inputFor, input.value);
    }, { signal });
    input.addEventListener("keydown", (event) => {
      if (!this.inputFor) return;
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        const id = this.inputFor;
        this.events.submit?.(id);
        this.blurField();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.blurField();
      }
      // Keys typed into the plate are not shortcuts of the interface.
      event.stopPropagation();
    }, { signal });
    input.addEventListener("blur", () => {
      if (this.inputFor) {
        this.inputFor = undefined;
        this.events.focus?.(null);
        this.dirty = true;
      }
    }, { signal });
    this.container.appendChild(input);
    return input;
  }

  // ------------------------------------------------------------------------------------------ end

  dispose() {
    this.disposed = true;
    this.abort.abort();
    this.input?.remove();
    for (const view of this.views.values()) view.texture.dispose();
    this.views.clear();
    this.discFace?.dispose();
    this.ringTexture?.dispose();
    this.shadowTexture.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
