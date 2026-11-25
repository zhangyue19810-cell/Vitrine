import * as THREE from "three";
import { ControlRail } from "./control-rail";
import { ArchiveVisibility } from "./archive-visibility";
import { ArchiveDrawCoverage, ArchiveShadowCoverage } from "./archive-draw-coverage";
import { InstanceUpdates } from "./instance-updates";
import { ArchiveStage, ARCHIVE_CARD_DEPTH_SCALE, ARCHIVE_FACE_Z, type FacePainter } from "./archive-stage";
import { RenderState } from "./render-state";
import { SharedDepthAO, SharedDepthBokeh } from "./shared-depth";
import { disposeThreeTree } from "./three-resources";
import { ThemeWave } from "./theme-motion";
import { themeMaterial, themeEnvironment } from "./theme-material";
import { RhythmMotion, rhythmDisplacement, quietBands, type MusicBands, type RhythmStyle } from "./archive-play-motion";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createArchiveLighting, type LightingLook } from "./archive-lighting";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { Cinema } from "./cinema";
import { normalizeQuality, type RenderQuality } from "./render-quality";
import { applyTextureQuality, resizeQuality } from "./quality-renderer";
import { CardAppearance } from "./appearance";
import type { RingMaterialPreset } from "./ring-materials";
import { configureInternalOptics } from "./internal-optics";
import { archiveEdgeFragment } from "./archive-edge";
import { DecryptionController } from "./decryption";
import { fileAtSlot, fileLocation } from "./data";
import {
  cellKey,
  sameCell,
  selectionCell,
  fileAtCell,
  poolCell,
  LOOP_COLUMNS,
  LOOP_ROWS,
  COLUMN_SPACING,
  ROW_SPACING,
  type ArchiveCell,
  type ArchiveNavigation,
} from "./archive-loop";
import { labelMarkSvg } from "./brand";
import { archiveFraming } from "./viewport-layout";
import { ArchiveDrag, ArchivePlaneMomentum, type DragAxis, type DragProjection, type DragPosition } from "./archive-drag";
import { assetUrl as publicAsset } from "./asset-url";
import { takeVisualAsset } from "./app/warmup";
import { fullMotion, reducedMotion, type MotionPreferences } from "./motion-preferences";
import {
  archiveWave,
  extraction,
  baselineSelectionWave,
  rippleEnvelope,
  settlingWave,
  damp,
  columnStrength,
  idleWave,
  cinematicField,
  INSPECTION_LIFT,
  returnStep,
} from "./motion";

const ease = (t: number) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** The ring hangs in empty space (the floor is far below it); the row stands on the floor. */
const FLOOR_HEIGHT = { ring: -34, row: -4.63 };
/** The key light shines on the ring from the front (the plates' faces are lit); the row keeps the lighting set-up's own place. */
const RING_LIGHT = new THREE.Vector3(-9, 15, 12);
/** Half sizes of the key light's shadow window: the ring is wider than the visible part of the row. */
const SHADOW_WINDOW = { ring: { x: 23, y: 19 }, row: { x: 16, y: 15 } };
export class ArchiveScene {
  private inputEvents = new AbortController();
  /** The plates and the music disc: a transparent second canvas over this one (see control-rail.ts). */
  readonly controls: ControlRail;
  private controlsLast = 0;
  private presence = 1;
  private presenceTarget = 1;
  setPresentationVisible(visible: boolean, immediate = false) {
    this.presenceTarget = Number(visible);
    if (immediate) this.presence = this.presenceTarget;
    if (!visible) this.cancelPointer();
  }
  get presentationHidden() { return this.presenceTarget === 0 && this.presence === 0; }
  private presentationDrop(cell: ArchiveCell) {
    const delay = .15 * (1 + Math.tanh((cell.row - this.selectedCell.row) * .1 + (cell.lane - this.selectedCell.lane) * .25));
    return 35 * Math.pow(THREE.MathUtils.clamp((1 - this.presence - delay) / .7, 0, 1), 2);
  }
  revealImmediately() { this.reveal = this.targetReveal; }
  dispose() {
    this.inputEvents.abort();
    this.cancelPointer();
    this.stage?.dispose();
    this.stage = undefined;
    disposeThreeTree(this.scene);
    this.appearance.disposeSources();
    this.model.clear();
    this.outgoing = [];
    this.instances = [];
    this.light.shadow.map?.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.loaded = false;
  }
  uiOnlyParallax = false;
  private theme = new ThemeWave();
  private subduedIndex = { value: 0 };
  private selectedIndexOnly = false;
  private superPerformance = false;
  setSuperPerformance(enabled: boolean) {
    if (this.superPerformance === enabled) return;
    this.superPerformance = enabled;
    for (const inst of this.instances) {
      const original = (inst.userData.fullMaterial ??= inst.material) as THREE.MeshPhysicalMaterial;
      if (enabled && !inst.userData.fastMaterial) {
        const fast = original.clone();
        const surface = original.name.replace(/\.\d+$/, "");
        fast.onBeforeCompile = original.onBeforeCompile;
        fast.customProgramCacheKey = original.customProgramCacheKey.bind(original);
        fast.transmission = 0;
        fast.clearcoat = 0;
        fast.roughness = Math.max(.45, original.roughness);
        this.appearance.trackSurface(fast, surface);
        inst.userData.fastMaterial = fast;
      }
      inst.material = enabled ? inst.userData.fastMaterial : original;
      inst.visible = !enabled || original.name.replace(/\.\d+$/, "") !== "Titanium_Fasteners";
    }
    this.resize();
  }
  setSelectedIndexAccent(onlySelected: boolean) { this.selectedIndexOnly = onlySelected; }
  private themeAttribute?: THREE.InstancedBufferAttribute;
  get themeAmount() { return this.theme.background(performance.now() / 1000); }
  /** What the page's own colours (the interface painted over the picture) follow: the theme, and deep space whichever theme it is. */
  get chromeAmount() { return Math.max(this.themeAmount, this.deepSpace()); }
  setTheme(dark: boolean, immediate = false) {
    this.theme.set(dark, performance.now() / 1000, this.selectedCell, immediate);
    this.controls.setDark(dark);
  }
  private playfield = { enabled: false, bands: quietBands(), strength: 1, flatten: 0, target: null as string | null, breathing: true };
  private flatMix = 0;
  private rhythm = new RhythmMotion();
  private rhythmStyle: RhythmStyle = "legacy";
  setRhythmStyle(style: RhythmStyle) { this.rhythmStyle = style; }
  private relayLifts = new Map<string, number>();
  private relayPoints = new Map<string, { cell: ArchiveCell; point: THREE.Vector3 }>();
  private relayActive = false;
  onRelayPick?: (key: string | null) => void;
  setPlayfield(enabled: boolean, bands: MusicBands, strength: number, flatten: number, target: string | null, breathing = true) {
    this.playfield = { enabled, bands, strength, flatten, target, breathing };
  }
  setRelayActive(active: boolean) {
    if (active === this.relayActive) return;
    this.cancelPointer(); this.setHover(null); this.relayActive = active;
    this.pointer.set(0, 0);
  }
  relayPulse(key: string) {
    const cell = this.relayPoints.get(key)?.cell;
    if (cell && !this.reduced) this.emitPulse(cell);
  }
  projectRelay(key: string) {
    const item = this.relayPoints.get(key);
    if (!item) return null;
    const point = item.point.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }
  relayCandidates() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.scene.updateMatrixWorld(true);
    return [...this.relayPoints.keys()].filter(key => {
      const p = this.projectRelay(key)!;
      const x = (p.x - rect.left) / rect.width, y = (p.y - rect.top) / rect.height;
      if (x < .18 || x > .82 || y < .32 || y > .76) return false;
      const hit = this.pickCell(p.x, p.y);
      return hit && cellKey(hit) === key;
    });
  }
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  // The reference uses a long lens 72–140 units from the cassette. A 0.1 near
  // plane quantizes adjacent optical layers to the same depth (visible shimmer).
  // All visible foreground geometry is beyond 5; retain the framing and lens.
  readonly camera = new THREE.PerspectiveCamera(34, 16 / 9, 5, 300);
  private composer: EffectComposer;
  private ao: SharedDepthAO;
  private bokeh: SharedDepthBokeh;
  private bloom: UnrealBloomPass;
  private instances: THREE.InstancedMesh[] = [];
  private matrixUpdates?: InstanceUpdates;
  private themeUpdates?: InstanceUpdates;
  private renderState = new RenderState();
  private shadowState = new RenderState();
  private renderedFrames = 0;
  private reusedFrames = 0;
  private visibility = new ArchiveVisibility();
  private drawCoverage = new ArchiveDrawCoverage();
  private shadowCoverage?: ArchiveShadowCoverage;
  private instanceCapacity = LOOP_COLUMNS * LOOP_ROWS;
  private drawnCells: ArchiveCell[] = [];
  private extraCoverage = false;
  setArchiveCoverage(extra: boolean) { this.extraCoverage = extra; }
  private model = new THREE.Group();
  private appearance = new CardAppearance();
  private ringMaterialPreset?: RingMaterialPreset;
  private decryption = new DecryptionController();
  private cursor = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private cells: ArchiveCell[] = [];
  private selectedCell: ArchiveCell = { lane: 2, row: 12 };
  private looping = false;
  private coordinateOrigin: ArchiveCell = { lane: 0, row: 0 };
  private lift = { value: 0, velocity: 0 };
  private rail = { value: 0, velocity: 0 };
  private shoulder = { value: 12, velocity: 0 };
  private laneFocus = { value: 2, velocity: 0 };
  private columnCamera = { value: 0, velocity: 0 };
  private returnY: number | null = null;
  private canInspect = false;
  private clearance = 0;
  private pulseGain = 1;
  private idleGain = 0;
  private lastInteraction = 0;
  private scanTime = 29.1;
  private scanBlend = 0;
  private cameraAim = new THREE.Vector3();
  private outgoing: {
    group: THREE.Group;
    slot: number;
    cell: ArchiveCell;
    lift: { value: number; velocity: number };
    returnY: number | null;
    clarity: number;
  }[] = [];
  private pulses: { row: number; lane: number; time: number }[] = [];
  private pendingPulse: ArchiveCell | null = null;
  private selectedSlot = 76;
  private detail = 0;
  private targetDetail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private last = 0;
  private pointer = new THREE.Vector2();
  private dragging = false;
  private hoverCell: ArchiveCell | null = null;
  private hoverLifts = new Map<string, number>();
  private archiveDrag = new ArchiveDrag();
  private dragTrack: DragPosition | null = null;
  private navigatingDrag = false;
  private archiveMomentum: { motion: ArchivePlaneMomentum; time: number } | null = null;
  private holdingArchive = false;
  private cancelPointer = () => {};
  private pendingHover: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType'> | null = null;
  private flushHover = () => {};
  private rotation = 0;
  private targetRotation = 0;
  private light: THREE.DirectionalLight;
  private clock = 0;
  private loaded = false;
  private labelCanvas = document.createElement("canvas");
  private labelTexture?: THREE.CanvasTexture;
  private labelMark = new Image();
  private motion: MotionPreferences = fullMotion();
  private quality = normalizeQuality(undefined);
  private appliedQuality = "";
  private smaa = new SMAAPass();
  /** Bloom, streak, fringing, vignette and grain: the look of the film for deep space (see `cinema.ts`). */
  private cinema!: Cinema;
  /** Whether this quality tier has the film at all (the performance tier does not). */
  private filmAllowed = true;
  private aoKernelSize = 32;
  private displayHeight = 0;
  private layoutKind = "";
  // ── The 3D stage (the Möbius ring at home, the single row of the download view): see archive-stage.ts. While it is on it
  //    draws the archives through the same instanced shells, the old grid sleeps and the old pointer handling is off (canBrowse).
  private stage?: ArchiveStage;
  private stageOn = false;
  private stagePending: { x: number; y: number } | null = null;
  private stageLast: { x: number; y: number } | null = null;
  private stageWasBusy = false;
  private stageLocked = false;
  /** The floor only exists for the row: the Möbius ring hangs in empty space. */
  private archiveFloor?: THREE.Mesh;
  /** The key light's place for the row (the one the lighting set-up chose); the ring is lit from the front instead. */
  private readonly rowLight = new THREE.Vector3();
  private cancelStage = () => {};
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  /** The stage once installed: the host feeds it items and listens to its events. */
  get stageHandle() {
    return this.stage;
  }
  get stageActive() {
    return this.stageOn;
  }
  installStage(painter: FacePainter) {
    if (this.stage) return this.stage;
    const stage = new ArchiveStage({ painter, anisotropy: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()) });
    stage.group.visible = this.stageOn;
    this.scene.add(stage.group);
    this.stage = stage;
    return stage;
  }
  setStageActive(active: boolean) {
    if (!this.stage || active === this.stageOn) return;
    this.cancelPointer();
    this.cancelStage();
    this.setHover(null);
    this.stageOn = active;
    this.canInspect = false;
    this.stagePending = null;
    this.stageLast = null;
    this.model.visible = !active;
    for (const old of this.outgoing) old.group.visible = !active;
    this.stage.group.visible = active;
    // Leaving the stage hands the floor, light and shadow window back to the old shelf (the row's values are its own).
    if (!active) this.shapeSurroundings(1);
    this.renderer.domElement.style.cursor = active ? "grab" : "default";
    this.renderState.invalidate();
    this.shadowState.invalidate();
  }
  /** While an instance's page is open the ring behind it is only to look at. */
  setStageLocked(locked: boolean) {
    if (locked === this.stageLocked) return;
    this.stageLocked = locked;
    this.cancelStage();
    this.stage?.setHover(null);
  }
  private stageReady() {
    return this.stageOn && !this.stageLocked && Boolean(this.stage) && this.presenceTarget === 1 && this.loaded && !this.relayActive && !this.container.closest("[inert]");
  }
  private pickStage(x: number, y: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.cursor.set(((x - rect.left) / rect.width) * 2 - 1, (-(y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.cursor, this.camera);
    return this.stage!.pick(this.raycaster.ray);
  }
  /** Where the pointer rests may change under it (the row scrolls, a transition ends): look again. */
  private flushStageHover() {
    const stage = this.stage!;
    const sample = this.stagePending;
    this.stagePending = null;
    if (!this.stageReady()) {
      stage.setHover(null);
      return;
    }
    const settled = this.stageWasBusy && !stage.busy;
    this.stageWasBusy = stage.busy;
    const point = sample ?? (this.stageLast && (settled || (stage.animating && !stage.busy)) ? this.stageLast : null);
    if (!point) return;
    const pick = this.pickStage(point.x, point.y);
    stage.setHover(pick ? pick.item : null, pick?.hotspot ?? null);
    // On the black hole the shadow and the track round it answer the pointer (a card in front of them takes it first).
    const at = this.ndcOf(point.x, point.y);
    const spot = pick ? null : stage.holeAt(at.x, at.y);
    stage.setHoleHover(spot ? spot.part : null);
    this.renderer.domElement.style.cursor = pick || spot?.part ? "pointer" : "grab";
  }
  /** Screen pixels that one slot of scrolling moves a card by (a vector: the row runs up and to the right). */
  private slotPixels() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const [from, to] = this.stage!.referenceSlots();
    this.camera.updateMatrixWorld();
    const a = this.stage!.slotCentre(from, this.tmpA).project(this.camera);
    const b = this.stage!.slotCentre(to, this.tmpB).project(this.camera);
    return { x: ((b.x - a.x) * rect.width) / 2, y: (-(b.y - a.y) * rect.height) / 2 };
  }
  /**
   * Presses, moves and the wheel that land on a plate or on the music disc belong to the rail. Its listeners are registered
   * before all others and stop a consumed event, so the archives behind a plate do not also see it.
   */
  private bindRailPointer() {
    const canvas = this.renderer.domElement;
    const signal = this.inputEvents.signal;
    const rail = this.controls;
    let captured: number | null = null;
    let wasOver = false;
    const settle = () => {
      wasOver = false;
      this.renderer.domElement.style.cursor = this.stageOn ? "grab" : "default";
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (captured !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (!rail.down(e.clientX, e.clientY)) return;
      captured = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      this.stage?.setHover(null);
      this.stagePending = null;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, { signal });
    canvas.addEventListener("pointermove", (e) => {
      if (captured !== null) {
        if (e.pointerId === captured) {
          rail.move(e.clientX, e.clientY);
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.pointerType !== "mouse") return;
      if (rail.move(e.clientX, e.clientY)) {
        wasOver = true;
        this.stage?.setHover(null);
        this.stagePending = null;
        this.stageLast = null;
        canvas.style.cursor = "pointer";
        e.stopImmediatePropagation();
      } else if (wasOver) settle();
    }, { signal });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== captured) return;
      captured = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      rail.up(e.clientX, e.clientY, cancelled);
      e.stopImmediatePropagation();
    };
    canvas.addEventListener("pointerup", (e) => release(e, false), { signal });
    canvas.addEventListener("pointercancel", (e) => release(e, true), { signal });
    canvas.addEventListener("lostpointercapture", (e) => release(e, true), { signal });
    canvas.addEventListener("pointerleave", () => {
      if (captured === null) rail.leave();
      if (wasOver) settle();
    }, { signal });
    canvas.addEventListener("wheel", (e) => {
      if (e.ctrlKey) return;
      if (rail.wheel(e.clientX, e.clientY, e.deltaY)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, { passive: false, signal });
    window.addEventListener("blur", () => rail.leave(), { signal });
  }
  /** A place on the page as a place on the picture (−1…1, y up). */
  private ndcOf(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, y: 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2 };
  }
  /** The pointer on the picture: the view of the black hole leans a little towards it. */
  private trackPointer(e: PointerEvent) {
    const at = this.ndcOf(e.clientX, e.clientY);
    this.stage?.pointAt(at.x, at.y);
  }
  private bindStagePointer() {
    const canvas = this.renderer.domElement;
    const signal = this.inputEvents.signal;
    const touch = { id: null as number | null, startX: 0, startY: 0, x: 0, y: 0, moved: false, time: 0, speed: 0 };
    // The three things a press can do to the black hole of the music world: turn the view (orbit), press its shadow (hole: a click
    // plays or pauses; moving far enough turns it into an orbit) or take hold of the track of the song round it (seek).
    const hold = { id: null as number | null, kind: "" as "" | "orbit" | "hole" | "seek", startX: 0, startY: 0, x: 0, y: 0, time: 0, vx: 0, vy: 0, turn: 0 };
    const fingers = new Map<number, { x: number; y: number }>();
    let pinchSpan = 0;
    let wheelTotal = 0;
    let wheelTime = 0;
    const span = () => {
      const [a, b] = [...fingers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const finish = () => {
      const id = touch.id;
      touch.id = null;
      touch.moved = false;
      touch.speed = 0;
      if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    const endHold = (cancelled: boolean) => {
      const { id, kind } = hold;
      hold.id = null;
      hold.kind = "";
      if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      if (kind === "orbit") this.stage?.view.release(cancelled ? 0 : hold.vx, cancelled ? 0 : hold.vy);
      else if (kind === "seek" && !cancelled) this.stage?.events.seek?.(hold.turn, true);
    };
    this.cancelStage = () => {
      if (touch.moved) this.stage?.endDrag(0);
      finish();
      endHold(true);
      fingers.clear();
      pinchSpan = 0;
      wheelTotal = 0;
      this.stagePending = null;
    };
    /** A press on empty space (or the shadow, or the track) of the black hole: which of the three it is, or false if it is not for the hole. */
    const takeHold = (e: PointerEvent): boolean => {
      const stage = this.stage;
      if (!stage || !stage.holeShown || hold.id !== null) return false;
      const mouse = e.pointerType === "mouse";
      if (mouse && e.button !== 0 && e.button !== 2) return false;
      const at = this.ndcOf(e.clientX, e.clientY);
      const spot = stage.holeAt(at.x, at.y);
      let kind: "orbit" | "hole" | "seek";
      if ((mouse && e.button === 2) || e.shiftKey) kind = "orbit";
      else if (this.pickStage(e.clientX, e.clientY)) return false;
      else if (spot?.part === "track") kind = "seek";
      else if (spot?.part === "shadow") kind = "hole";
      else kind = "orbit";
      hold.id = e.pointerId;
      hold.kind = kind;
      hold.startX = hold.x = e.clientX;
      hold.startY = hold.y = e.clientY;
      hold.time = e.timeStamp;
      hold.vx = hold.vy = 0;
      hold.turn = spot?.turn ?? 0;
      canvas.setPointerCapture(e.pointerId);
      stage.setHover(null);
      this.stagePending = null;
      if (kind === "orbit") {
        stage.view.grab();
        canvas.style.cursor = "grabbing";
      } else if (kind === "seek") {
        stage.events.seek?.(hold.turn, false);
        canvas.style.cursor = "grabbing";
      }
      return true;
    };
    canvas.addEventListener("pointerdown", (e) => {
      const stage = this.stage;
      if (this.stageOn && stage) this.trackPointer(e);
      if (this.stageOn && stage?.holeShown) {
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (fingers.size === 2) {
          // A second finger: the two of them pinch the hole bigger or smaller, whatever the first was doing.
          if (touch.moved) stage.endDrag(0);
          finish();
          endHold(true);
          pinchSpan = span();
          return;
        }
        if (fingers.size === 1 && touch.id === null && takeHold(e)) return;
      }
      if (!this.stageReady() || (e.pointerType === "mouse" && e.button !== 0) || touch.id !== null) return;
      touch.id = e.pointerId;
      touch.startX = touch.x = e.clientX;
      touch.startY = touch.y = e.clientY;
      touch.moved = false;
      touch.speed = 0;
      touch.time = e.timeStamp;
      this.stagePending = null;
      canvas.setPointerCapture(e.pointerId);
    }, { signal });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.stageOn || !this.stage) return;
      const stage = this.stage;
      if (fingers.has(e.pointerId)) {
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (fingers.size === 2 && pinchSpan > 0) {
          const now = span();
          if (now > 0) stage.view.scaleBy(now / pinchSpan);
          pinchSpan = now;
          return;
        }
      }
      if (e.pointerType === "mouse" || touch.id !== null || hold.id !== null) this.trackPointer(e);
      if (hold.id !== null) {
        if (e.pointerId !== hold.id) return;
        if (hold.kind === "hole") {
          if (Math.hypot(e.clientX - hold.startX, e.clientY - hold.startY) < 7) return;
          hold.kind = "orbit";
          stage.view.grab();
          canvas.style.cursor = "grabbing";
        }
        if (hold.kind === "orbit") {
          const height = Math.max(1, canvas.getBoundingClientRect().height);
          const dx = (e.clientX - hold.x) / height;
          const dy = (e.clientY - hold.y) / height;
          stage.view.drag(dx, dy);
          const seconds = Math.max(1, e.timeStamp - hold.time) / 1000;
          hold.vx += (dx / seconds - hold.vx) * 0.35;
          hold.vy += (dy / seconds - hold.vy) * 0.35;
          hold.x = e.clientX;
          hold.y = e.clientY;
          hold.time = e.timeStamp;
        } else if (hold.kind === "seek") {
          const at = this.ndcOf(e.clientX, e.clientY);
          const spot = stage.holeAt(at.x, at.y);
          if (spot) {
            hold.turn = spot.turn;
            stage.events.seek?.(spot.turn, false);
          }
        }
        return;
      }
      if (touch.id === null) {
        if (e.pointerType === "mouse") this.stageLast = this.stagePending = { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.pointerId !== touch.id) return;
      if (!touch.moved) {
        if (Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) < 7) return;
        touch.moved = true;
        stage.setHover(null);
        canvas.style.cursor = "grabbing";
      }
      const per = this.slotPixels();
      const slots = -((e.clientX - touch.x) * per.x + (e.clientY - touch.y) * per.y) / Math.max(1, per.x * per.x + per.y * per.y);
      stage.dragBy(slots);
      const seconds = Math.max(1, e.timeStamp - touch.time) / 1000;
      touch.speed += (slots / seconds - touch.speed) * 0.35;
      touch.x = e.clientX;
      touch.y = e.clientY;
      touch.time = e.timeStamp;
    }, { signal });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (fingers.delete(e.pointerId) && fingers.size < 2) pinchSpan = 0;
      if (e.pointerId === hold.id) {
        const kind = hold.kind;
        endHold(cancelled);
        // A press on the shadow that did not move is a click: play or pause.
        if (kind === "hole" && !cancelled) this.stage?.events.hole?.();
        this.stageLast = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = "grab";
        return;
      }
      if (e.pointerId !== touch.id) return;
      const { moved, speed } = touch;
      finish();
      if (!this.stage) return;
      if (moved) this.stage.endDrag(cancelled ? 0 : speed);
      else if (!cancelled && this.stageReady()) this.stage.click(this.pickStage(e.clientX, e.clientY));
      this.stageLast = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerup", (e) => release(e, false), { signal });
    canvas.addEventListener("pointercancel", (e) => release(e, true), { signal });
    canvas.addEventListener("lostpointercapture", (e) => release(e, true), { signal });
    canvas.addEventListener("pointerleave", () => {
      this.stagePending = this.stageLast = null;
      if (touch.id === null && hold.id === null) {
        this.stage?.setHover(null);
        this.stage?.setHoleHover(null);
      }
      this.stage?.pointAt(null);
    }, { signal });
    canvas.addEventListener("contextmenu", (e) => {
      if (this.stageOn && this.stage?.holeShown) e.preventDefault();
    }, { signal });
    // A double click on empty space brings the hole back to the composed picture.
    canvas.addEventListener("dblclick", (e) => {
      const stage = this.stage;
      if (!this.stageOn || !stage?.holeShown || this.pickStage(e.clientX, e.clientY)) return;
      const at = this.ndcOf(e.clientX, e.clientY);
      if (stage.holeAt(at.x, at.y)?.part) return;
      stage.view.reset();
    }, { signal });
    canvas.addEventListener("wheel", (e) => {
      if (!this.stageOn || !this.stage) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl (or ⌘) with the wheel, and the pinch of a trackpad (which arrives as the same), come closer to or go away from the hole.
        if (!this.stage.holeShown) return;
        e.preventDefault();
        const pinch = e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 30;
        const raw = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? canvas.clientHeight : 1);
        this.stage.view.scaleBy(Math.exp(-THREE.MathUtils.clamp(raw, -300, 300) * (pinch ? 0.012 : 0.0015)));
        return;
      }
      // The 3D view owns the wheel: one notch moves the selection by one archive.
      e.preventDefault();
      if (!this.stageReady() || touch.id !== null || hold.id !== null) return;
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const delta = THREE.MathUtils.clamp(raw * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? canvas.clientHeight : 1), -300, 300);
      const now = performance.now();
      if (now - wheelTime > 180 || Math.sign(delta) !== Math.sign(wheelTotal)) wheelTotal = 0;
      wheelTime = now;
      wheelTotal += delta;
      const steps = Math.min(3, Math.floor(Math.abs(wheelTotal) / 80));
      if (!steps) return;
      const direction = Math.sign(wheelTotal);
      wheelTotal -= direction * steps * 80;
      this.stage.step(direction * steps);
    }, { passive: false, signal });
    window.addEventListener("blur", () => this.cancelStage(), { signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelStage();
    }, { signal });
  }
  /**
   * The ring floats in empty space; the row stands on a floor. The floor, the key light and its shadow window follow how far
   * the picture has become the row (`flat`: 0 = ring, 1 = row), so the surroundings change smoothly with the archives.
   */
  private shapeSurroundings(flat: number, deep = 0) {
    const k = THREE.MathUtils.clamp(flat, 0, 1);
    const blend = k * k * (3 - 2 * k);
    if (this.archiveFloor) {
      // In deep space there is no floor: it sinks away (its colour has already turned to the dark of the sky) and is left out.
      this.archiveFloor.position.y = THREE.MathUtils.lerp(FLOOR_HEIGHT.ring, FLOOR_HEIGHT.row, blend) - deep * deep * 70;
      this.archiveFloor.visible = blend > 0.001 && deep < 0.995;
    }
    this.light.position.lerpVectors(RING_LIGHT, this.rowLight, blend);
    const window = this.light.shadow.camera;
    const x = THREE.MathUtils.lerp(SHADOW_WINDOW.ring.x, SHADOW_WINDOW.row.x, blend);
    const y = THREE.MathUtils.lerp(SHADOW_WINDOW.ring.y, SHADOW_WINDOW.row.y, blend);
    if (window.right !== x || window.top !== y) {
      Object.assign(window, { left: -x, right: x, top: y, bottom: -y });
      window.updateProjectionMatrix();
    }
  }
  /** How much of the picture is deep space right now (0 … 1, eased): the cosmos and the deck of the music page. */
  private deepSpace() {
    const amount = this.stageOn && this.stage ? this.stage.worldAmount : 0;
    return amount * amount * (3 - 2 * amount);
  }
  /** The sky is written once (it needs the renderer), the depth of field leaves it sharp, and its stars are as large as the pixels are. */
  private prepareSky(stage: ArchiveStage, deep: number) {
    this.bokeh.setEmptySharp(deep);
    if (stage.worldAmount <= 0.001) return;
    if (!stage.sky.ready) stage.sky.bake(this.renderer);
    stage.sky.setPixelScale(Math.max(0.75, this.renderer.getPixelRatio()));
  }
  /** One frame of the stage: poses, the camera shot, the instanced shells, then the common render tail. */
  private updateStage(time: number, dt: number) {
    const stage = this.stage!;
    this.flushStageHover();
    stage.setAspect(this.camera.aspect);
    stage.setPresence(this.presence);
    stage.setInstant(!this.motion.selectionTransition);
    // Plates and printed faces take the dark look in deep space, whichever theme is chosen.
    const deep = this.deepSpace();
    stage.setThemeAmount(Math.max(this.themeAmount, deep));
    stage.setAmbient(this.motion.idleWave);
    stage.update(dt);
    this.shapeSurroundings(stage.layoutBlend, deep);
    this.prepareSky(stage, deep);

    // The stage owns the shot (aim, direction, distance, height of the picture); the lens follows from them.
    const shot = stage.cameraState();
    this.cameraAim.set(shot.aim[0], shot.aim[1], shot.aim[2]);
    this.camera.position.set(
      shot.aim[0] + shot.dir[0] * shot.distance,
      shot.aim[1] + shot.dir[1] * shot.distance,
      shot.aim[2] + shot.dir[2] * shot.distance,
    );
    this.camera.lookAt(this.cameraAim);
    this.camera.fov = THREE.MathUtils.radToDeg(shot.fov);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const fog = this.scene.fog as THREE.Fog;
    const fogTheme = this.themeAmount;
    // The ring is shallow (a few fog-lengths); the row runs a long way into the picture and must not fade out.
    const flat = stage.layoutBlend;
    fog.near = shot.distance + THREE.MathUtils.lerp(5 - 4 * fogTheme, 16, flat);
    fog.far = shot.distance + THREE.MathUtils.lerp(25 - 9 * fogTheme, 95 - 25 * fogTheme, flat);
    // Deep space is deep: the far plates fade into the dark only slowly.
    fog.near = THREE.MathUtils.lerp(fog.near, shot.distance + 30, deep);
    fog.far = THREE.MathUtils.lerp(fog.far, shot.distance + 170, deep);

    // The archives: the stage's matrices go into the same instance buffers the old grid used.
    const count = stage.count;
    this.ensureInstanceCapacity(count);
    this.matrixUpdates ??= new InstanceUpdates(this.instances[0].instanceMatrix);
    if (this.themeAttribute) this.themeUpdates ??= new InstanceUpdates(this.themeAttribute);
    this.shadowCoverage?.begin();
    const origin = this.selectedCell;
    const wave = { lane: origin.lane, row: origin.row };
    for (let i = 0; i < count; i++) {
      const at = i * 16;
      this.matrixUpdates.set(at, stage.matrices.subarray(at, at + 16));
      this.dummy.matrix.fromArray(stage.matrices, at);
      this.shadowCoverage?.add(this.dummy.matrix);
      wave.row = origin.row + Math.round(stage.distances[i] * 4) / 4;
      this.themeUpdates?.scalar(i, this.theme.sample(wave, time));
    }
    const countChanged = this.instances[0].count !== count;
    const visibleChanged = this.matrixUpdates.commit();
    const shadowChanged = this.shadowCoverage?.commit() ?? false;
    for (const inst of this.instances) inst.count = count;
    if (visibleChanged || shadowChanged || countChanged || !this.instances[0].boundingSphere) this.instances[0].computeBoundingSphere();
    this.themeUpdates?.commit();
    this.drawnCells = [];
    this.relayPoints.clear();

    // `detail` is "the instance's page is open beside the ring": the host washes the right of the picture with it. The row
    // has no such page (its details are printed on the pulled-out archive itself), so it must not wash anything.
    this.detail = stage.layout === "ring" ? stage.pullAmount * (1 - stage.layoutBlend) : 0;
    this.container.dataset.inspection = "preview";
    this.finishFrame(stage.animating || visibleChanged || shadowChanged || countChanged, stage.focus, stage.pullAmount);
  }
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onHover?: (index: number | null) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  constructor(
    private container: HTMLElement,
    private readonly selectionPulse = baselineSelectionWave,
    private readonly deferSelectionPulse = false,
    private readonly lightingLook: LightingLook = "baseline",
    rendererOptions: { antialias?: boolean; powerPreference?: WebGLPowerPreference } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: rendererOptions.antialias ?? true,
      alpha: false,
      powerPreference: rendererOptions.powerPreference ?? "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5) *
        Math.min(innerWidth / 1920, innerHeight / 1080),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    // All composer passes see the same geometry within one application frame.
    // Generate the shadow map in the beauty pass and reuse it in depth/normal passes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "三维实例架，点击选择，左右拖动切换分组，上下拖动或滚轮切换分组内的实例",
    );
    container.appendChild(this.renderer.domElement);
    this.controls = new ControlRail(container);
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.renderState.invalidate();
      this.shadowState.invalidate();
    }, { signal: this.inputEvents.signal });
    this.scene.background = new THREE.Color("#eae5e1");
    // The frame updates world matrices once after simulation; subsequent
    // beauty, normal, depth and transmission renders reuse those same matrices.
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.fog = new THREE.Fog("#eae5e1", 22, 47);
    this.light = createArchiveLighting(this.renderer, this.scene, lightingLook);
    this.light.castShadow = true;
    Object.assign(this.light.shadow.camera, {
      left: -16,
      right: 16,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 45,
    });
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = lightingLook === "refined" ? 0.018 : 0.035;
    this.light.shadow.bias = lightingLook === "refined" ? -0.00012 : -0.0003;
    this.light.shadow.radius = 4;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshPhysicalMaterial({
        color: "#d8c9b9",
        roughness: 0.72,
        metalness: 0.04,
        clearcoat: 0.22,
        clearcoatRoughness: 0.5,
        envMapIntensity: 0.82,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.name = "archive-floor";
    floor.position.y = -4.63;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.archiveFloor = floor;
    this.rowLight.copy(this.light.position);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.fov = 6.15;
    this.camera.lookAt(this.cameraAim);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SharedDepthAO(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.ao.kernelRadius = lightingLook === "refined" ? 0.5 : 0.42;
    this.ao.minDistance = 0.001;
    this.ao.maxDistance = 0.09;
    this.composer.addPass(this.ao);
    this.bokeh = new SharedDepthBokeh(this.scene, this.camera, {
      focus: 25,
      aperture: 0.0018,
      maxblur: 0.011,
    }, () => this.ao);
    this.composer.addPass(this.bokeh);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)),
      0.27,
      0.36,
      0.84,
    );
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.cinema = new Cinema(container.clientWidth, container.clientHeight);
    this.composer.addPass(this.cinema.bloom);
    this.composer.addPass(this.cinema.grade);
    this.composer.addPass(new OutputPass());
    // The rail's listeners come first so that a press on a plate never reaches the archives behind it.
    this.bindRailPointer();
    this.bindPointer();
    this.bindStagePointer();
  }
  async load(assetUrl = publicAsset("assets/archive-cassette.glb")) {
    this.labelMark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
    await this.labelMark.decode();
    const loader = new GLTFLoader();
    const cached = takeVisualAsset(assetUrl);
    const gltf = cached
      ? await loader.parseAsync(cached.slice(0), assetUrl)
      : await loader.loadAsync(assetUrl);
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const count = LOOP_COLUMNS * LOOP_ROWS;
    for (let index = 0; index < count; index++) {
      const cell = poolCell(index);
      this.cells.push(cell);
    }
    for (const mesh of meshes) {
      // The source cassette is deliberately wafer-thin. Stretch only its depth
      // axis so the thicker optical stack has a real side wall to read against
      // and the selected archive gets a more substantial silhouette.
      const geom = mesh.geometry
        .clone()
        .applyMatrix4(mesh.matrixWorld)
        .scale(1, 1, ARCHIVE_CARD_DEPTH_SCALE);
      const source = mesh.material as THREE.MeshStandardMaterial;
      const name = source.name.replace(/\.\d+$/, "");
      // Promote every archive surface to a physical material: the edge and
      // cover layers need transmission, clearcoat, sheen and iridescence even
      // when the GLB only supplied a metallic-roughness material. Physical
      // sources clone normally so their optical maps are preserved.
      let mat: THREE.MeshPhysicalMaterial;
      if (source instanceof THREE.MeshPhysicalMaterial) {
        mat = source.clone();
      } else {
        mat = new THREE.MeshPhysicalMaterial();
        THREE.MeshStandardMaterial.prototype.copy.call(mat, source);
        // MeshStandardMaterial.copy writes its own defines; restore the
        // physical shader flags after copying the common material settings.
        mat.defines = { STANDARD: "", PHYSICAL: "" };
      }
      mat.envMapIntensity = 1.0;
      if (name === "Frosted_Polymer") {
        mat.color.set("#f5f1e9");
        mat.transmission = 0.9;
        mat.thickness = 0.78;
        mat.roughness = 0.12;
        mat.ior = 1.52;
        mat.dispersion = 0.16;
        mat.attenuationColor = new THREE.Color("#dbc4a4");
        mat.attenuationDistance = 0.76;
        mat.clearcoat = 0.9;
        mat.clearcoatRoughness = 0.07;
        mat.envMapIntensity = 1.8;
        mat.iridescence = 0.12;
        mat.iridescenceIOR = 1.34;
        mat.iridescenceThicknessRange = [110, 310];
      }
      if (name === "Internal_Ceramic") {
        mat.color.set(this.lightingLook === "refined" ? "#a49789" : "#b8aa9c");
        mat.roughness = 0.48;
        mat.clearcoat = 0.32;
        mat.clearcoatRoughness = 0.24;
      }
      if (name === "Printed_Label") {
        mat.color.set("#e8dfd2");
        mat.roughness = 0.54;
      }
      if (name === "Ivory_Edges") {
        // The outer rail is now brushed champagne metal rather than a second
        // glass pane: a clear material break between the cover and its frame.
        mat.color.set("#cfb37a");
        mat.metalness = 0.82;
        mat.roughness = 0.2;
        mat.transmission = 0;
        mat.thickness = 0;
        mat.clearcoat = 0.84;
        mat.clearcoatRoughness = 0.1;
        mat.envMapIntensity = 2.0;
        mat.sheen = 0.24;
        mat.sheenColor = new THREE.Color("#ffe7b8");
        mat.sheenRoughness = 0.32;
        mat.iridescence = 0.16;
        mat.iridescenceIOR = 1.38;
        mat.iridescenceThicknessRange = [140, 360];
      }
      if (name === "Optical_Diffuser") {
        mat.color.set("#846c50");
        mat.transmission = 0;
        mat.roughness = 0.58;
        mat.clearcoat = 0.3;
        mat.clearcoatRoughness = 0.24;
        mat.envMapIntensity = 1.4;
      }
      if (name === "Subsurface_Optics") {
        mat.color.set(this.lightingLook === "refined" ? "#b09a84" : "#b4a391");
        mat.roughness = 0.42;
        mat.metalness = 0.1;
        mat.clearcoat = 0.42;
        mat.clearcoatRoughness = 0.2;
      }
      if (name === "Optical_Edges") {
        // Internal refractive shoulders must be in the opaque capture: WebGL's
        // screen-space transmission cannot recursively sample another glass mesh.
        mat.transmission = 0;
        mat.color.set(this.lightingLook === "refined" ? "#a08c6b" : "#ab9878");
        mat.roughness = 0.14;
        mat.metalness = 0.88;
        mat.clearcoat = 0.72;
        mat.clearcoatRoughness = 0.1;
        mat.envMapIntensity = 2.1;
      }
      if (name === "Titanium_Fasteners") {
        mat.color.set("#c6bfad");
        mat.metalness = 0.94;
        mat.roughness = 0.16;
        mat.clearcoat = 0.54;
        mat.clearcoatRoughness = 0.08;
        mat.envMapIntensity = 2.35;
        mat.iridescence = 0.08;
        mat.iridescenceIOR = 1.3;
      }
      if (name === "Index_Inlay") {
        mat.color.set("#e0b35f");
        mat.metalness = 0.72;
        mat.roughness = 0.2;
        mat.clearcoat = 0.86;
        mat.clearcoatRoughness = 0.09;
        mat.envMapIntensity = 1.96;
      }
      configureInternalOptics(name, mat);
      if (name === "Carbon_Ink") continue;
      const selectedMesh = new THREE.Mesh(geom, mat);
      selectedMesh.userData.surface = name;
      selectedMesh.castShadow = name === "Optical_Diffuser";
      selectedMesh.receiveShadow = true;
      this.model.add(selectedMesh);
      // Only the shell, edge and fasteners remain visible within tightly packed rows.
      // Keep sub-millimetre optical/typographic geometry on the extracted cassette.
      if (
        ![
          "Frosted_Polymer",
          "Ivory_Edges",
          "Titanium_Fasteners",
          "Index_Inlay",
          "Optical_Diffuser",
        ].includes(name)
      ) {
        this.appearance.register(name, mat);
        continue;
      }
      const arrayMat = mat.clone();
      if (name === "Frosted_Polymer") {
        arrayMat.transmission = 0.58;
        arrayMat.thickness = 0.68;
        arrayMat.attenuationColor.set("#d6b995");
        arrayMat.attenuationDistance = 0.92;
        arrayMat.transparent = false;
        arrayMat.color.set("#e8dcc8");
        arrayMat.clearcoat = 0.84;
        arrayMat.clearcoatRoughness = 0.1;
        arrayMat.envMapIntensity = 1.72;
        arrayMat.ior = 1.5;
        arrayMat.dispersion = 0.12;
        arrayMat.iridescence = 0.1;
        arrayMat.iridescenceIOR = 1.32;
        arrayMat.iridescenceThicknessRange = [110, 300];
        arrayMat.onBeforeCompile = (shader) => {
          shader.vertexShader =
            "varying float vPanelHeight;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 3.7;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\n" + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.32, 0.23, 0.15), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight));",
          );
          shader.fragmentShader = archiveEdgeFragment(shader.fragmentShader);
        };
        arrayMat.roughness = 0.18;
      }
      if (name === "Optical_Diffuser") {
        arrayMat.color.set("#725b42");
        arrayMat.roughness = 0.54;
        arrayMat.clearcoat = 0.28;
        arrayMat.clearcoatRoughness = 0.26;
        arrayMat.envMapIntensity = 1.28;
      }
      if (name === "Ivory_Edges") {
        arrayMat.transmission = 0;
        arrayMat.color.set(this.lightingLook === "refined" ? "#b99a62" : "#c7aa70");
        arrayMat.metalness = 0.76;
        arrayMat.roughness = 0.24;
        arrayMat.clearcoat = 0.78;
        arrayMat.clearcoatRoughness = 0.12;
        arrayMat.envMapIntensity = 1.86;
        arrayMat.sheen = 0.2;
        arrayMat.sheenColor = new THREE.Color("#ffe6b2");
        arrayMat.sheenRoughness = 0.34;
        arrayMat.iridescence = 0.14;
        arrayMat.iridescenceIOR = 1.36;
        arrayMat.iridescenceThicknessRange = [140, 340];
      }
      if (name === "Index_Inlay") {
        arrayMat.color.set("#d8a94f");
        arrayMat.metalness = 0.68;
        arrayMat.roughness = 0.23;
        arrayMat.clearcoat = 0.74;
        arrayMat.clearcoatRoughness = 0.12;
        arrayMat.envMapIntensity = 1.86;
      }
      if (name === "Titanium_Fasteners") {
        arrayMat.color.set("#b8af9b");
        arrayMat.metalness = 0.92;
        arrayMat.roughness = 0.18;
        arrayMat.clearcoat = 0.48;
        arrayMat.clearcoatRoughness = 0.08;
        arrayMat.envMapIntensity = 2.05;
        arrayMat.iridescence = 0.08;
        arrayMat.iridescenceIOR = 1.3;
      }
      this.appearance.register(name, mat, arrayMat);
      this.themeAttribute ??= new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("archiveTheme", this.themeAttribute);
      themeMaterial(arrayMat, name, true, this.subduedIndex);
      const inst = new THREE.InstancedMesh(geom, arrayMat, count);
      // All surfaces move rigidly together; share the transform buffer on the GPU.
      inst.instanceMatrix = this.instances[0]?.instanceMatrix ?? inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = name === "Optical_Diffuser";
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.instances.push(inst);
      this.scene.add(inst);
    }
    this.shadowCoverage = new ArchiveShadowCoverage(this.instances.find(mesh => mesh.castShadow)!);
    this.scene.add(this.shadowCoverage.mesh);
    this.labelCanvas.width = 1024;
    this.labelCanvas.height = 440;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy =
      this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.99, 0.46),
      new THREE.MeshBasicMaterial({
        map: this.labelTexture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    // This separate selected-instance decal sits a hair in front of the staged
    // faces; both must clear the stretched glass cover.
    label.position.set(-1.36, 3.04, ARCHIVE_FACE_Z + 0.008);
    this.model.add(label);
    this.appearance.prepare(this.model);
    this.appearance.apply(this.model, 0);
    if (this.ringMaterialPreset) this.appearance.setRingMaterial(this.ringMaterialPreset);
    this.drawLabel(0);
    this.scene.add(this.model);
    this.model.position.copy(this.cellPosition(poolCell(this.selectedSlot)));
    this.loaded = true;
  }

  setMode(mode: "hidden" | "archive" | "detail") {
    this.cancelPointer();
    this.setHover(null);
    if (mode === "detail") this.decryption.enter(this.scanBlend > .9 && this.decryption.clarity > .999);
    else this.decryption.leave();
    if (mode === "hidden") this.decryption.select();
    if (mode !== "archive") this.pendingPulse = null;
    this.looping = mode !== "hidden";
    if (!this.looping) {
      const canonical = fileLocation(fileAtSlot(this.selectedSlot));
      this.selectedCell = { lane: canonical.lane, row: canonical.row };
      this.coordinateOrigin = { lane: 0, row: 0 };
      for (const old of this.outgoing) {
        this.scene.remove(old.group);
        this.appearance.dispose(old.group);
      }
      this.outgoing = [];
    }
    this.lastInteraction = this.clock;
    this.targetReveal = mode === "hidden" ? 0 : 1;
    this.targetDetail = mode === "detail" ? 1 : 0;
    this.dragging = false;
    if (mode !== "detail") {
      this.targetRotation = 0;
      if (this.rotation !== 0) this.returnY = this.model.position.y;
    } else this.returnY = null;
  }
  // Legacy review pages use the old whole-scene toggle.
  setReduced(value: boolean) { this.setMotion(value ? reducedMotion() : fullMotion()); }
  setMotion(value: MotionPreferences) {
    if ((!value.pointerParallax || !value.dragMomentum) && (this.motion.pointerParallax || this.motion.dragMomentum)) this.cancelPointer();
    if (!value.dragMomentum) {
      this.archiveMomentum = null;
      this.columnCamera.velocity = 0;
      this.rail.velocity = 0;
    }
    if (!value.pointerParallax) this.pointer.set(0, 0);
    if (!value.selectionWave) this.pulses = [];
    if (!value.idleWave) this.idleGain = 0;
    this.motion = { ...value };
    if (!value.modelDecryption) {
      this.appearance.setClarity(this.model, this.modelClarity());
      for (const old of this.outgoing) {
        old.clarity = 0;
        this.appearance.setClarity(old.group, 0);
      }
    }
  }
  private get reduced() { return Object.values(this.motion).every(value => !value); }
  private modelClarity() {
    // Disabling the reveal animation preserves the material state of each mode.
    return this.motion.modelDecryption ? this.decryption.clarity : this.targetDetail;
  }
  /** Apply a PBR preset to the whole ring (glass, metal, inlay and edge families independently). */
  setRingMaterial(preset: RingMaterialPreset) {
    this.ringMaterialPreset = preset;
    this.appearance.setRingMaterial(preset);
    this.renderState.invalidate();
  }

  setQuality(value: RenderQuality | boolean) {
    const quality =
      typeof value === "boolean"
        ? normalizeQuality(undefined, value)
        : normalizeQuality(value);
    const key = JSON.stringify(quality);
    if (this.appliedQuality === key) return;
    this.appliedQuality = key;
    this.quality = quality;
    if (quality.aoSamples && quality.aoSamples !== this.aoKernelSize) {
      const old = this.ao;
      this.ao = new SharedDepthAO(this.scene, this.camera, 1, 1, quality.aoSamples);
      this.ao.kernelRadius = old.kernelRadius;
      this.ao.minDistance = old.minDistance;
      this.ao.maxDistance = old.maxDistance;
      const index = this.composer.passes.indexOf(old);
      this.composer.removePass(old);
      this.composer.insertPass(this.ao, index);
      old.dispose();
      this.aoKernelSize = quality.aoSamples;
    }
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    // A very restrained HDR bloom picks out the warm key reflections and the
    // fine metal edges. It is intentionally skipped on the software tier.
    this.bloom.enabled = !this.superPerformance && quality.aoSamples >= 16;
    this.smaa.enabled = quality.antialias === "smaa";
    this.filmAllowed = quality.depthOfField > 0;
    this.cinema.setStreak(quality.scale >= 100);
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(
      quality.shadows || 1024,
      this.renderer.capabilities.maxTextureSize,
    );
    if (this.light.shadow.mapSize.x !== size) {
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
      this.light.shadow.mapSize.set(size, size);
    }
    this.light.shadow.needsUpdate = true;
    applyTextureQuality(this.scene, this.renderer, quality);
    this.resize();
  }
  private cellPosition(cell: ArchiveCell) {
    return new THREE.Vector3(
      (cell.lane - 2) * COLUMN_SPACING,
      -4.6,
      (cell.row - 15.5) * ROW_SPACING,
    );
  }
  private rebaseCoordinates() {
    // Periodically reduce the logical coordinates while preserving every
    // relative position, spring velocity, ripple and idle phase.
    const shift = {
      lane:
        Math.abs(this.selectedCell.lane) > 2048
          ? Math.round((this.selectedCell.lane - 2) / 5) * 5
          : 0,
      row:
        Math.abs(this.selectedCell.row) > 2048
          ? Math.floor((this.selectedCell.row - 12) / 8) * 8
          : 0,
    };
    if (!shift.lane && !shift.row) return;
    this.setHover(null);
    this.hoverLifts.clear();
    this.selectedCell.lane -= shift.lane;
    this.selectedCell.row -= shift.row;
    this.coordinateOrigin.lane += shift.lane;
    this.coordinateOrigin.row += shift.row;
    this.laneFocus.value -= shift.lane;
    this.shoulder.value -= shift.row;
    this.columnCamera.value -= shift.lane * COLUMN_SPACING;
    this.rail.value += shift.row * ROW_SPACING;
    for (const old of this.outgoing) {
      old.cell.lane -= shift.lane;
      old.cell.row -= shift.row;
    }
    for (const pulse of this.pulses) {
      pulse.lane -= shift.lane;
      pulse.row -= shift.row;
    }
    if (this.pendingPulse) {
      this.pendingPulse.lane -= shift.lane;
      this.pendingPulse.row -= shift.row;
    }
  }
  select(index: number, navigation?: ArchiveNavigation) {
    if (!this.navigatingDrag) this.cancelPointer();
    this.setHover(null);
    this.lastInteraction = this.clock;
    const next = fileLocation(index).slot;
    const canonical = fileLocation(index);
    const cell = this.looping
      ? selectionCell(index, this.selectedCell, navigation)
      : { lane: canonical.lane, row: canonical.row };
    const changed = !sameCell(cell, this.selectedCell);
    if (this.looping && changed && this.loaded && this.lift.value > 0.0001) {
      const group = this.model.clone(true);
      const label = group.children[group.children.length - 1] as THREE.Mesh;
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 440;
      canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      label.material = new THREE.MeshBasicMaterial({
        map,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      });
      // Clone carries the selected label material by reference. Replace it
      // before installing appearance shaders, so theme hooks are not appended
      // to the original label a second time on every selection.
      this.appearance.prepare(group);
      this.appearance.apply(group, ease(this.lift.value / 0.4));
      this.appearance.setClarity(group, this.modelClarity());
      this.scene.add(group);
      this.outgoing.push({
        group,
        slot: this.selectedSlot,
        cell: { ...this.selectedCell },
        lift: { ...this.lift },
        returnY: group.rotation.y !== 0 ? group.position.y : null,
        clarity: this.modelClarity(),
      });
      this.lift.value = 0;
      this.lift.velocity = 0;
    }
    this.selectedSlot = next;
    this.selectedCell = cell;
    if (changed) {
      this.decryption.select();
      this.rotation = 0;
      this.returnY = null;
    }
    const returning = this.outgoing.findIndex((o) => sameCell(o.cell, cell));
    if (returning >= 0) {
      const o = this.outgoing[returning];
      this.lift = { ...o.lift };
      this.rotation = o.group.rotation.y;
      this.returnY = o.returnY;
      this.decryption.select(o.clarity);
      this.scene.remove(o.group);
      this.appearance.dispose(o.group);
      this.outgoing.splice(returning, 1);
    }
    if (this.deferSelectionPulse) {
      this.pendingPulse = this.looping ? { ...cell } : null;
    } else this.emitPulse(cell);
    this.targetRotation = 0;
    this.drawLabel(index);
  }
  private emitPulse(cell: ArchiveCell) {
    this.pulses.push({ ...cell, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }
  /** Paints the printed label of the extracted cassette; set by the launcher (see app/label.ts). */
  labelPainter?: (ctx: CanvasRenderingContext2D, index: number, mark: HTMLImageElement) => void;
  private labelIndex = 0;
  /** Redraw the current label (after a rename, or once a font has finished loading). */
  refreshLabel() {
    this.drawLabel(this.labelIndex);
  }
  private drawLabel(index: number) {
    this.labelIndex = index;
    if (!this.labelTexture) return;
    const c = this.labelCanvas.getContext("2d")!;
    c.fillStyle = "#e6e2d9";
    c.fillRect(0, 0, 1024, 440);
    this.labelPainter?.(c, index, this.labelMark);
    this.labelTexture.needsUpdate = true;
  }
  private ensureInstanceCapacity(required: number) {
    if (required <= this.instanceCapacity) return;
    const capacity = Math.max(required, this.instanceCapacity * 2);
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
    matrix.array.set(this.instances[0].instanceMatrix.array);
    for (const inst of this.instances) {
      inst.dispose();
      inst.instanceMatrix = matrix;
    }
    const previousTheme = this.themeAttribute;
    this.themeAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    if (previousTheme) this.themeAttribute.array.set(previousTheme.array);
    for (const inst of this.instances) inst.geometry.setAttribute("archiveTheme", this.themeAttribute);
    this.matrixUpdates = new InstanceUpdates(matrix);
    this.themeUpdates = new InstanceUpdates(this.themeAttribute);
    this.instanceCapacity = capacity;
  }
  resize() {
    this.renderState.invalidate();
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    const kind = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "";
    const displayHeight = this.container.getBoundingClientRect().height;
    if (this.layoutKind === "cinematic" && kind !== "cinematic" && this.displayHeight > 0) {
      // Removing letterboxing starts from the same apparent model size. The
      // existing camera interpolation then carries it to the responsive anchor.
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * displayHeight / this.displayHeight,
      ));
    }
    this.displayHeight = displayHeight;
    this.layoutKind = kind;
    const dimensions = resizeQuality(
      this.renderer,
      this.composer,
      this.container,
      this.quality,
      this.superPerformance,
    );
    this.ao.setSize(
      Math.max(1, Math.floor(dimensions.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(dimensions.height * this.quality.aoResolution)),
    );
    this.ao.setSharing(this.ao.enabled && this.quality.depthOfField > 0 && this.quality.aoResolution === 1 && !this.superPerformance);
    this.container.dataset.renderQuality = JSON.stringify({
      ...JSON.parse(this.container.dataset.renderQuality!),
      aoSamples: this.ao.enabled ? this.aoKernelSize : 0,
      aoWidth: this.ao.width,
      aoHeight: this.ao.height,
      shadows: this.renderer.shadowMap.enabled
        ? this.light.shadow.mapSize.x
        : 0,
      depthOfField: this.bokeh.enabled ? this.quality.depthOfField : 0,
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls.resize();
  }
  private canBrowse() {
    return (
      !this.stageOn &&
      this.presenceTarget === 1 &&
      this.looping &&
      !this.targetDetail &&
      this.detail < 0.2 &&
      this.reveal >= 0.8 &&
      this.loaded &&
      !this.container.closest("[inert]")
    );
  }
  private setHover(cell: ArchiveCell | null) {
    if (
      (!cell && !this.hoverCell) ||
      (cell && this.hoverCell && sameCell(cell, this.hoverCell))
    )
      return;
    this.hoverCell = cell ? { ...cell } : null;
    this.onHover?.(cell ? fileAtCell(cell) : null);
  }
  private pickCell(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.cursor.set(
      ((x - r.left) / r.width) * 2 - 1,
      (-(y - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.cursor, this.camera);
    const hit = this.raycaster.intersectObjects(
      [this.instances[0], this.model, ...this.outgoing.map((o) => o.group)],
      true,
    )[0];
    if (!hit) return null;
    if (hit.instanceId !== undefined) return { ...this.drawnCells[hit.instanceId] };
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      const copy = this.outgoing.find((o) => o.group === object);
      if (copy) return { ...copy.cell };
      object = object.parent;
    }
    return { ...this.selectedCell };
  }
  private trackCoordinate(axis: DragAxis, value: number) {
    return axis === "lane"
      ? value / COLUMN_SPACING + 2
      : (-value - 2.17) / ROW_SPACING + 15.5;
  }
  private dragProjection(): DragProjection {
    this.model.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const center = this.model.localToWorld(new THREE.Vector3(0, 1.85, 0));
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (motion: THREE.Vector3) => {
      const from = center
        .clone()
        .addScaledVector(motion, -0.5)
        .project(this.camera);
      const to = center
        .clone()
        .addScaledVector(motion, 0.5)
        .project(this.camera);
      return {
        x: ((to.x - from.x) * rect.width) / 2,
        y: (-(to.y - from.y) * rect.height) / 2,
      };
    };
    // Positive navigation moves the array along -X for columns and -Z for rows.
    return {
      lane: project(new THREE.Vector3(-COLUMN_SPACING, 0, 0)),
      row: project(new THREE.Vector3(0, 0, -ROW_SPACING)),
    };
  }
  private trackPosition(axis: DragAxis, coordinate: number) {
    return axis === "lane"
      ? (coordinate - 2) * COLUMN_SPACING
      : -2.17 - (coordinate - 15.5) * ROW_SPACING;
  }
  private navigatePlane(coordinate: DragPosition) {
    const goal = { lane: Math.round(coordinate.lane), row: Math.round(coordinate.row) };
    if (sameCell(goal, this.selectedCell)) return;
    const from = { ...this.selectedCell };
    const steps = Math.min(64, Math.max(Math.abs(goal.lane - from.lane), Math.abs(goal.row - from.row)));
    this.navigatingDrag = true;
    try {
      // Select physical cells along the travelled segment in one update per cell.
      // Column memory is updated by onSelect, but never pulls a held plane away.
      for (let i = 1; i <= steps; i++) {
        const cell = {
          lane: Math.round(from.lane + (goal.lane - from.lane) * i / steps),
          row: Math.round(from.row + (goal.row - from.row) * i / steps),
        };
        if (!sameCell(cell, this.selectedCell)) this.onSelect?.(fileAtCell(cell), cell);
      }
    } finally {
      this.navigatingDrag = false;
    }
  }
  private stopMomentum() {
    if (this.archiveMomentum) {
      this.columnCamera.velocity = 0;
      this.rail.velocity = 0;
    }
    this.archiveMomentum = null;
  }
  private bindPointer() {
    const canvas = this.renderer.domElement;
    let activePointer: number | null = null;
    let previousX = 0,
      startX = 0,
      startY = 0,
      moved = false;
    let browse = false,
      cancelled = false;
    let startTrack = { lane: 0, row: 0 };
    let wheelTotal = 0,
      wheelTime = 0;
    const pointers = new Set<number>();
    const hover = (e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType'>) => {
      if (
        e.pointerType !== "mouse" ||
        !this.canBrowse() ||
        this.archiveMomentum
      )
        return;
      const r = canvas.getBoundingClientRect();
      this.pointer.set(
        (e.clientX - r.left) / r.width - 0.5,
        (e.clientY - r.top) / r.height - 0.5,
      );
      const cell = this.pickCell(e.clientX, e.clientY);
      this.setHover(cell);
      canvas.style.cursor = cell ? "pointer" : "grab";
    };
    this.flushHover = () => {
      const sample = this.pendingHover;
      this.pendingHover = null;
      if (sample) hover(sample);
    };
    const reset = () => {
      this.pendingHover = null;
      const id = activePointer;
      activePointer = null;
      this.dragging = false;
      this.dragTrack = null;
      this.holdingArchive = false;
      browse = false;
      this.setHover(null);
      canvas.style.cursor = this.canBrowse() ? "grab" : "default";
      if (id !== null && canvas.hasPointerCapture(id))
        canvas.releasePointerCapture(id);
    };
    this.cancelPointer = () => {
      cancelled = true;
      this.stopMomentum();
      pointers.clear();
      wheelTotal = 0;
      reset();
    };
    const moveArchive = (e: PointerEvent) => {
      const pending = !this.archiveDrag.active;
      for (const sample of e.getCoalescedEvents?.() ?? []) {
        this.archiveDrag.move(sample.clientX, sample.clientY, sample.timeStamp);
      }
      this.archiveDrag.move(e.clientX, e.clientY, e.timeStamp);
      moved ||= this.archiveDrag.moved;
      if (!this.archiveDrag.active) return;
      if (pending) {
        startTrack = { lane: this.columnCamera.value, row: this.rail.value };
      }
      this.setHover(null);
      this.lastInteraction = this.clock;
      canvas.style.cursor = "grabbing";
      this.dragTrack = {
        lane: startTrack.lane + this.archiveDrag.value.lane * COLUMN_SPACING,
        row: startTrack.row - this.archiveDrag.value.row * ROW_SPACING,
      };
      this.columnCamera.value = this.dragTrack.lane;
      this.rail.value = this.dragTrack.row;
      this.columnCamera.velocity = this.rail.velocity = 0;
      this.navigatePlane({
        lane: this.trackCoordinate("lane", this.columnCamera.value),
        row: this.trackCoordinate("row", this.rail.value),
      });
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!this.canBrowse() && !this.canInspect) return;
      this.pendingHover = null;
      pointers.add(e.pointerId);
      if (pointers.size > 1) {
        cancelled = true;
        reset();
        return;
      }
      activePointer = e.pointerId;
      cancelled = false;
      moved = this.archiveMomentum !== null;
      startX = previousX = e.clientX;
      startY = e.clientY;
      browse = this.canBrowse();
      this.stopMomentum();
      if (browse) {
        this.columnCamera.velocity = 0;
        this.rail.velocity = 0;
      }
      this.holdingArchive = browse;
      this.dragging = !browse && this.canInspect;
      startTrack = { lane: this.columnCamera.value, row: this.rail.value };
      this.archiveDrag.start(e.clientX, e.clientY, this.dragProjection(), e.timeStamp);
      this.setHover(null);
      canvas.setPointerCapture(e.pointerId);
      if (this.relayActive) { this.holdingArchive = false; this.dragging = false; }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointermove", (e) => {
      if (this.relayActive) {
        if (e.pointerId === activePointer) moved ||= Math.hypot(e.clientX - startX, e.clientY - startY) > 7;
        return;
      }
      if (activePointer !== null && e.pointerId !== activePointer) return;
      if (activePointer === null) {
        // Coalesce uncaptured hover only; dragging and release velocity stay immediate.
        this.pendingHover = { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType };
        return;
      }
      if (cancelled) return;
      moved ||= Math.hypot(e.clientX - startX, e.clientY - startY) > 7;
      if (browse) {
        if (!this.canBrowse()) {
          this.cancelPointer();
          return;
        }
        moveArchive(e);
        return;
      }
      if (this.dragging && this.canInspect) {
        this.targetRotation = THREE.MathUtils.clamp(
          this.targetRotation + (e.clientX - previousX) * 0.004,
          -0.8,
          0.8,
        );
        previousX = e.clientX;
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId !== activePointer) return;
      if (this.relayActive) {
        if (!cancelled && !moved) { const cell = this.pickCell(e.clientX, e.clientY); this.onRelayPick?.(cell ? cellKey(cell) : null); }
        reset(); return;
      }
      if (!cancelled && browse && this.canBrowse()) {
        moveArchive(e);
        if (this.archiveDrag.active) {
          if (this.motion.dragMomentum) {
            this.archiveMomentum = {
              time: performance.now() / 1000,
              motion: new ArchivePlaneMomentum(
                { lane: this.trackCoordinate("lane", this.columnCamera.value), row: this.trackCoordinate("row", this.rail.value) },
                this.archiveDrag.releaseVelocity(e.timeStamp, false),
              ),
            };
          }
        } else if (!moved) {
          const cell = this.pickCell(e.clientX, e.clientY);
          if (cell) this.onSelect?.(fileAtCell(cell), cell);
        }
      }
      reset();
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) {
        cancelled = true;
        reset();
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("lostpointercapture", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) {
        cancelled = true;
        reset();
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointerleave", () => {
      this.pendingHover = null;
      this.pointer.set(0, 0);
      this.setHover(null);
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.relayActive) { e.preventDefault(); return; }
        if (
          !this.canBrowse() ||
          activePointer !== null ||
          e.ctrlKey ||
          Math.abs(e.deltaX) > Math.abs(e.deltaY)
        )
          return;
        e.preventDefault();
        if (this.archiveMomentum) this.stopMomentum();
        const now = performance.now();
        const delta = THREE.MathUtils.clamp(
          e.deltaY *
            (e.deltaMode === 1
              ? 40
              : e.deltaMode === 2
                ? canvas.clientHeight
                : 1),
          -300,
          300,
        );
        if (now - wheelTime > 180 || Math.sign(delta) !== Math.sign(wheelTotal))
          wheelTotal = 0;
        wheelTime = now;
        wheelTotal += delta;
        const steps = Math.min(3, Math.floor(Math.abs(wheelTotal) / 100));
        if (!steps) return;
        const direction = Math.sign(wheelTotal);
        wheelTotal -= direction * steps * 100;
        this.navigatingDrag = true;
        try {
          for (let i = 0; i < steps; i++) this.onNavigate?.("row", direction);
        } finally {
          this.navigatingDrag = false;
        }
      },
      { ...{ passive: false }, signal: this.inputEvents.signal },
    );
    window.addEventListener("blur", () => this.cancelPointer(), { signal: this.inputEvents.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelPointer();
    }, { signal: this.inputEvents.signal });
    window.addEventListener("resize", () => this.cancelPointer(), { signal: this.inputEvents.signal });
    // After multi-touch cancels capture, a finger can finish outside the canvas.
    window.addEventListener("pointerup", (e) => pointers.delete(e.pointerId), { signal: this.inputEvents.signal });
    window.addEventListener("pointercancel", (e) =>
      pointers.delete(e.pointerId), { signal: this.inputEvents.signal }
    );
  }
  update(time: number, cinematic?: { reveal: number; lift: number; zoom: number; time: number }) {
    this.updateWorld(time, cinematic);
    this.controls.update(Math.min(0.05, Math.max(0, time - this.controlsLast)), time);
    this.controlsLast = time;
  }
  private updateWorld(
    time: number,
    cinematic?: { reveal: number; lift: number; zoom: number; time: number },
  ) {
    const elapsed = Math.max(0, time - this.last || 0.016);
    const dt = Math.min(elapsed, 0.05);
    this.last = time;
    this.clock = time;
    if (!this.loaded) return;
    this.flushHover();
    const step = !this.motion.surfaceTransitions ? 1 : Math.min(elapsed, .25) / 1.1;
    this.presence += Math.sign(this.presenceTarget - this.presence) * Math.min(step, Math.abs(this.presenceTarget - this.presence));
    this.renderer.domElement.style.opacity = String(THREE.MathUtils.clamp(this.presence / .16, 0, 1));
    this.theme.beginFrame();
    themeEnvironment(this.scene, this.renderer, this.themeAmount, this.deepSpace());
    if (this.stageOn && this.stage) {
      this.updateStage(time, dt);
      return;
    }
    const blend = 1 - Math.exp(-dt * (this.motion.selectionTransition ? 2.8 : 35));
    const detailBlend = 1 - Math.exp(-dt * (this.motion.detailTransition ? 2.8 : 35));
    this.reveal = cinematic
      ? cinematic.reveal
      : THREE.MathUtils.lerp(this.reveal, this.targetReveal, blend);
    this.rotation = this.targetDetail
      ? THREE.MathUtils.lerp(this.rotation, this.targetRotation, detailBlend)
      : returnStep(this.rotation, dt, !this.motion.detailTransition);
    const shot = cinematic?.time ?? 29.1;
    if (cinematic) {
      this.scanTime = shot;
      this.scanBlend = 1;
    } else {
      this.scanTime += dt;
      this.scanBlend *= Math.exp(-dt * 3);
    }
    if (!this.canBrowse()) {
      this.setHover(null);
      if (this.holdingArchive || this.archiveMomentum) this.cancelPointer();
    }
    if (this.looping && !cinematic && !this.holdingArchive && !this.archiveMomentum) this.rebaseCoordinates();
    const momentum = !cinematic ? this.archiveMomentum : null;
    if (momentum) {
      momentum.motion.step(Math.min(Math.max(time - momentum.time, 0), 0.25));
      momentum.time = time;
      this.navigatePlane(momentum.motion.value);
      this.lastInteraction = time;
    }
    const hoverKey = !cinematic && this.hoverCell ? cellKey(this.hoverCell) : null;
    if (hoverKey && !this.hoverLifts.has(hoverKey)) this.hoverLifts.set(hoverKey, 0);
    for (const [key, value] of this.hoverLifts) {
      const target = key === hoverKey ? 0.28 : 0;
      const next = cinematic ? 0 : !this.motion.selectionTransition ? target : THREE.MathUtils.lerp(value, target, 1 - Math.exp(-dt * 14));
      if (target === 0 && next < 0.0001) this.hoverLifts.delete(key);
      else this.hoverLifts.set(key, next);
    }
    const hoverLift = (cell: ArchiveCell) => this.hoverLifts.get(cellKey(cell)) ?? 0;
    const chosen = this.cellPosition(this.selectedCell);
    const selectedRow = this.selectedCell.row;
    const selectedLane = this.selectedCell.lane;
    damp(this.shoulder, selectedRow, this.motion.selectionTransition ? 5 : 35, dt);
    damp(this.laneFocus, selectedLane, this.motion.selectionTransition ? 4 : 35, dt);
    // A held or freely coasting plane owns both tracks; selection cannot pull it.
    if (!this.holdingArchive && !momentum) {
      damp(this.columnCamera, chosen.x, this.motion.selectionTransition ? 3.7 : 35, dt);
      damp(this.rail, cinematic ? 0 : -2.17 - chosen.z, this.motion.selectionTransition ? 3.7 : 35, dt);
    }
    if (momentum) {
      this.columnCamera.value = this.trackPosition("lane", momentum.motion.lane.value);
      this.rail.value = this.trackPosition("row", momentum.motion.row.value);
      this.columnCamera.velocity = momentum.motion.lane.velocity * COLUMN_SPACING;
      this.rail.velocity = -momentum.motion.row.velocity * ROW_SPACING;
      if (momentum.motion.phase === "idle") this.archiveMomentum = null;
    }
    if (this.dragTrack && !cinematic) {
      this.columnCamera.value = this.dragTrack.lane;
      this.rail.value = this.dragTrack.row;
      this.columnCamera.velocity = this.rail.velocity = 0;
    }
    if (cinematic) {
      this.rail.value = 0;
      this.rail.velocity = 0;
      this.lift.value = extraction(shot);
      this.lift.velocity = 0;
      this.shoulder.value = selectedRow;
      this.laneFocus.value = selectedLane;
      this.laneFocus.velocity = 0;
      this.columnCamera.value = chosen.x;
      this.columnCamera.velocity = 0;
    }
    // Keep the illuminated set near the origin. Lateral navigation is a track
    // movement of the whole array, just like the existing front/back rail.
    const trackX = cinematic ? 0 : this.columnCamera.value;
    this.pulses = this.pulses.filter((p) => time - p.time < 3.2);
    const aligningCopy = this.outgoing.some((o) => o.returnY !== null);
    const idle =
      !cinematic &&
      this.motion.idleWave &&
      this.targetReveal > 0 &&
      !this.targetDetail &&
      this.detail < 0.01 &&
      this.returnY === null &&
      !aligningCopy &&
      time - this.lastInteraction > 2.5;
    this.idleGain = cinematic
      ? 0
      : THREE.MathUtils.lerp(
          this.idleGain,
          idle ? (this.playfield.enabled ? (this.playfield.breathing && !this.relayActive ? 1 - this.playfield.bands.activity : 0) : 1) : 0,
          1 - Math.exp(-dt * (idle ? 0.8 : 4)),
        );
    this.pulseGain = THREE.MathUtils.lerp(
      this.pulseGain,
      this.targetDetail || this.returnY !== null || aligningCopy ? 0 : 1,
      1 - Math.exp(-dt * 8),
    );
    const play = this.playfield;
    const activePlay = !cinematic && !this.targetDetail && play.enabled;
    const rhythm = this.rhythm.update(activePlay && !this.reduced ? play.bands : quietBands(), time, dt, this.rhythmStyle);
    this.flatMix += ((activePlay ? play.flatten : 0) - this.flatMix) * (this.reduced ? 1 : 1 - Math.exp(-dt * 4));
    this.subduedIndex.value = Math.max(Number(this.selectedIndexOnly), this.flatMix);
    const indexDim = (lift: number) => this.selectedIndexOnly
      ? 1 - ease(lift / .4) * (1 - this.flatMix)
      : this.flatMix;
    const gameTarget = activePlay ? play.target : null;
    if (gameTarget && !this.relayLifts.has(gameTarget)) this.relayLifts.set(gameTarget, 0);
    for (const [key, height] of this.relayLifts) {
      const next = height + ((key === gameTarget ? .95 : 0) - height) * (this.reduced ? 1 : 1 - Math.exp(-dt * 8));
      if (next < .001 && key !== gameTarget) this.relayLifts.delete(key); else this.relayLifts.set(key, next);
    }
    const spectrumPoint = new THREE.Vector3();
    const screenX = (row: number, lane: number) => {
      spectrumPoint.set((lane - 2) * COLUMN_SPACING - trackX, -4.6, (row - 15.5) * ROW_SPACING + this.rail.value).project(this.camera);
      return (spectrumPoint.x + 1) / 2;
    };
    const fieldCache = new Map<number, Map<number, number>>();
    const calculateField = (row: number, lane: number) => {
      if (cinematic)
        return cinematicField(
          row,
          lane,
          shot,
          this.shoulder.value,
          this.laneFocus.value,
        );
      const height =
        archiveWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          this.scanTime,
        ) *
          this.scanBlend;
      const breathing = idleWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          time,
        ) *
          this.idleGain;
      let pulseHeight = 0;
      if (!cinematic && this.motion.selectionWave) {
        let ripple = 0;
        for (const p of this.pulses) {
          const distance = Math.hypot(row - p.row, (lane - p.lane) * 2.2);
          const age = time - p.time;
          ripple +=
            this.selectionPulse(distance, age) *
            (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
        }
        pulseHeight = THREE.MathUtils.clamp(ripple, -0.6, 0.6) * this.pulseGain;
      }
      const distance = row - this.shoulder.value;
      return (
        (height +
        settlingWave(distance, 26.56) *
          columnStrength(lane, this.laneFocus.value)) * (1 - this.flatMix) + breathing + pulseHeight +
        (activePlay && !this.reduced ? rhythmDisplacement(row, lane, time, play.bands, play.strength, rhythm, screenX(row, lane)) : 0) +
        (this.relayLifts.get(cellKey({ row, lane })) ?? 0)
      );
    };
    const field = (row: number, lane: number): number => {
      let values = fieldCache.get(lane);
      if (!values) { values = new Map(); fieldCache.set(lane, values); }
      const previous = values.get(row);
      if (previous !== undefined) return previous;
      const value = calculateField(row, lane);
      values.set(row, value);
      return value;
    };
    const selectedBase = chosen.y + field(selectedRow, selectedLane);
    if (!cinematic) {
      if (this.returnY !== null && this.rotation !== 0) {
        this.lift.value = this.returnY - selectedBase;
        this.lift.velocity = 0;
      } else {
        this.returnY = null;
        damp(
          this.lift,
          this.targetDetail
            ? INSPECTION_LIFT
            : this.outgoing.some(
                  (o) =>
                    o.returnY !== null &&
                    o.cell.lane === selectedLane &&
                    Math.abs(o.cell.row - selectedRow) < 5,
                )
              ? 0
              : 0.4 * this.targetReveal * (1 - this.flatMix),
          !this.motion.detailTransition
            ? 35
            : this.deferSelectionPulse &&
                !this.targetDetail &&
                this.lift.value < 0.4
              ? 7.6
              : 4.2,
          dt,
        );
      }
    }
    const cameraTarget = this.targetDetail
      ? ease((this.lift.value - 0.8) / 2.4)
      : this.returnY !== null
        ? this.detail
        : ease((this.lift.value - 0.4) / (INSPECTION_LIFT - 0.4));
    this.detail = cinematic
      ? cinematic.zoom
      : THREE.MathUtils.lerp(this.detail, cameraTarget, detailBlend);
    const detail = this.detail;
    // Keep the physical decryption timeline alive even when its model visuals
    // are disabled; the document mask uses the same timeline independently.
    this.decryption.update(dt, detail > .78 && this.lift.value > 3.3, false,
      cinematic ? shot + 5 : undefined);
    this.appearance.apply(this.model, ease(this.lift.value / 0.4));
    this.appearance.setClarity(this.model, this.modelClarity());
    // Reference 26.92–27.76: the array travels horizontally into a white field.
    const entry = cinematic ? ease((shot - 21.9) / 0.86) : this.reveal;
    const entranceTime = THREE.MathUtils.clamp((shot - 21.92) / 0.75, 0, 1);
    const entryZ = cinematic
      ? -23 * (1 - entranceTime) ** 2
      : -28 * (1 - entry);
    for (let i = this.outgoing.length - 1; i >= 0; i--) {
      const o = this.outgoing[i];
      const p = this.cellPosition(o.cell);
      const baseY = p.y + field(o.cell.row, o.cell.lane);
      o.group.rotation.y = returnStep(o.group.rotation.y, dt, !this.motion.detailTransition);
      if (o.returnY !== null) {
        o.lift.value = o.returnY - baseY;
        o.lift.velocity = 0;
        if (o.group.rotation.y === 0) o.returnY = null;
      } else damp(o.lift, 0, this.motion.detailTransition ? 4.5 : 35, dt);
      o.group.position.set(
        p.x - trackX,
        baseY + o.lift.value + hoverLift(o.cell) - this.presentationDrop(o.cell),
        p.z + entryZ + this.rail.value,
      );
      const quality = ease(o.lift.value / 0.4);
      this.appearance.apply(o.group, quality);
      this.appearance.setTheme(o.group, this.theme.sample(o.cell, time), indexDim(o.lift.value));
      o.clarity = this.motion.modelDecryption ? o.clarity * Math.exp(-dt * 9) : 0;
      this.appearance.setClarity(o.group, o.clarity);
      const { row, lane } = o.cell;
      o.group.rotation.x =
        (field(row + 0.5, lane) - field(row - 0.5, lane)) *
        0.024 *
        (1 - detail) *
        (1 - quality);
      if (o.lift.value < 0.0001 && Math.abs(o.group.rotation.y) < 0.0001) {
        this.scene.remove(o.group);
        this.appearance.dispose(o.group);
        this.outgoing.splice(i, 1);
      }
    }
    if (
      this.pendingPulse &&
      !cinematic &&
      !this.targetDetail &&
      this.targetReveal
    ) {
      const selectedY = selectedBase + this.lift.value;
      const oldCardsLower = this.outgoing.every(
        (old) =>
          old.cell.lane !== selectedLane ||
          Math.abs(old.cell.row - selectedRow) > 4 ||
          old.group.position.y + 0.015 < selectedY,
      );
      // The new file causes the wave: finish most of its rise and let nearby
      // outgoing files get below it before starting the outward pulse.
      if (this.lift.value >= 0.35 && this.returnY === null && oldCardsLower) {
        if (this.motion.selectionWave) this.emitPulse(this.pendingPulse);
        this.pendingPulse = null;
      }
    }
    this.appearance.setTheme(this.model, this.theme.sample(this.selectedCell, time), indexDim(this.lift.value));
    this.model.position.set(
      chosen.x - trackX,
      chosen.y + field(selectedRow, selectedLane) + this.lift.value + hoverLift(this.selectedCell) - this.presentationDrop(this.selectedCell),
      chosen.z + entryZ + this.rail.value,
    );
    // Extraction only changes elevation. Reframing belongs to the camera.
    this.model.rotation.set(
      (field(selectedRow + 0.5, selectedLane) -
        field(selectedRow - 0.5, selectedLane)) *
        0.024 *
        (1 - detail) *
        (1 - ease(this.lift.value / 0.4)),
      cinematic ? 0 : this.rotation,
      0,
    );
    // Measured from frame 787: X edge (382,-204), adjacent row (78,38).
    // The label vertical edge constrains height; the file base is occluded.
    // Do not calibrate field of view from the visible fragment of a file.
    const orbit = ease((shot - 22.6) / 1.6);
    const settle = ease((shot - 24.25) / 2.25);
    const yaw = THREE.MathUtils.degToRad(89 - 22 * orbit - 8 * settle);
    const elevation = THREE.MathUtils.degToRad(
      3 + 40 * ease((shot - 21.96) / 0.22) - 8 * orbit - 16 * settle,
    );
    const span = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.8, 10.3, orbit),
      7.33,
      settle,
    );
    const responsiveOpening = Boolean(cinematic) && this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "opening";
    const openingAspect = responsiveOpening ? this.container.clientWidth / this.container.clientHeight / (16 / 9) : 1;
    const openingSpan = (value: number) => value / Math.min(1, openingAspect);
    const distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(28 + 7 * orbit, 140, settle),
      72,
      detail,
    );
    const arrayAim = new THREE.Vector3(
      -1.091,
      THREE.MathUtils.lerp(-2.55 + 0.4 * orbit, -0.045, settle),
      THREE.MathUtils.lerp(2.48, 0.481, settle),
    );
    const cameraAim = arrayAim.clone();
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    if (cinematic) {
      const earlyTurn = ease((shot - 27.3) / 1.3);
      const finalTurn = ease((shot - 28.6) / 5.4);
      const shotYaw =
        yaw - THREE.MathUtils.degToRad(9 * earlyTurn + 32 * finalTurn);
      const shotElevation =
        elevation - THREE.MathUtils.degToRad(1.5 * earlyTurn + 3.7 * finalTurn);
      viewDirection.set(
        -Math.sin(shotYaw) * Math.cos(shotElevation),
        Math.sin(shotElevation),
        Math.cos(shotYaw) * Math.cos(shotElevation),
      );
    } else {
      viewDirection
        .lerp(new THREE.Vector3(-0.277, 0.238, 0.931), detail)
        .normalize();
    }
    if (cinematic) {
      const pan = ease((shot - 25.4) / 0.95);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      cameraAim.addScaledVector(
        right,
        -2.05 * (1 - pan) * ease((shot - 24.2) / 0.8),
      );
    }
    if (cinematic && shot >= 25.05 && shot <= 27.3) {
      // Frames 760–785: the camera carries the same physical column from the
      // right into the selected position while the neighboring crests subside.
      const pan = ease((shot - 25.4) / 1.05);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const pixelScale = 1080 / openingSpan(span);
      const anchorAim = this.model.position
        .clone()
        .add(new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(
        right,
        -(THREE.MathUtils.lerp(840, 518, pan) - 960) * openingAspect / pixelScale,
      );
      anchorAim.addScaledVector(
        up,
        -(540 - THREE.MathUtils.lerp(340, 288, pan)) / pixelScale,
      );
      cameraAim.lerp(anchorAim, ease((shot - 25.05) / 0.35));
    }
    if (cinematic && shot > 27.3) {
      const close = ease((shot - 27.3) / 6.7);
      const extractionCamera = ease((shot - 27.3) / 1.25);
      const screenX = THREE.MathUtils.lerp(
        518 - 98 * extractionCamera,
        618,
        close,
      );
      const screenY = THREE.MathUtils.lerp(
        296 + 34 * extractionCamera,
        287,
        close,
      );
      const pixelScale = 1080 / openingSpan(THREE.MathUtils.lerp(span, 5.9, detail));
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const anchorAim = this.model.position
        .clone()
        .add(new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(right, -(screenX - 960) * openingAspect / pixelScale);
      anchorAim.addScaledVector(up, -(540 - screenY) / pixelScale);
      cameraAim.lerp(anchorAim, ease((shot - 27.3) / 0.5));
    }
    const framing = archiveFraming(this.container.clientWidth, this.container.clientHeight, span, detail,
      this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact");
    if (!cinematic) {
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const width = this.container.clientWidth, height = this.container.clientHeight;
      const pixelScale = height / framing.span;
      if (framing.portrait) {
        // Keep the preview camera independent of the live lift, wave and rail.
        // Following model.position here would visually cancel those motions.
        const previewAim = new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * height / pixelScale);
        cameraAim.copy(previewAim);
      }
      const detailAim = this.model.position
        .clone()
        .add(new THREE.Vector3(0, 1.85, 0));
      detailAim.addScaledVector(right, (0.5 - framing.detailX) * width / pixelScale);
      detailAim.addScaledVector(up, (framing.detailY - 0.5) * height / pixelScale);
      cameraAim.lerp(detailAim, detail);
    }
    const cameraPosition = cameraAim
      .clone()
      .addScaledVector(viewDirection, distance);
    if (!cinematic && this.motion.pointerParallax && !this.uiOnlyParallax) {
      cameraPosition.x += this.pointer.x * 0.12;
      cameraPosition.y -= this.pointer.y * 0.12;
    }
    const cameraTransition = this.targetDetail || this.detail > 0.01
      ? this.motion.detailTransition
      : this.motion.selectionTransition;
    const cameraBlend = cinematic ? 1 : cameraTransition ? 1 - Math.exp(-dt * 5) : 1;
    this.camera.position.lerp(cameraPosition, cameraBlend);
    this.cameraAim.lerp(cameraAim, cameraBlend);
    this.camera.lookAt(this.cameraAim);
    this.camera.fov = THREE.MathUtils.lerp(
      this.camera.fov,
      THREE.MathUtils.radToDeg(
        2 * Math.atan((cinematic ? openingSpan(THREE.MathUtils.lerp(span, 5.9, detail)) : framing.span) / (2 * distance)),
      ),
      cameraBlend,
    );
    const fog = this.scene.fog as THREE.Fog;
    // The camera position is damped after its target distance changes. Anchor
    // fog to the rendered camera, or entry puts the array behind the far plane
    // until the camera catches up (a brief white wash that exit never showed).
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    const fogTheme = this.themeAmount;
    fog.near = renderedDistance + THREE.MathUtils.lerp(5 - 4 * fogTheme, -1, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(25 - 9 * fogTheme, 12, detail);

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // Music can depend on projected X; invalidate after the camera advances.
    if (activePlay && !this.reduced) fieldCache.clear();
    // Build and compact the instance set only after the actual damped camera
    // is final for this frame. Picking uses the same packed index-to-cell map.
    const fixed = (Boolean(cinematic) || !this.looping) && !responsiveOpening;
    this.cells = fixed ? Array.from({ length: 160 }, (_, i) => poolCell(i))
      : this.visibility.update(this.camera, fog.far, trackX, entryZ + this.rail.value, this.extraCoverage);
    const hidden = new Set(this.outgoing.map(o => cellKey(o.cell)));
    hidden.add(cellKey(this.selectedCell));
    this.drawnCells = [];
    this.relayPoints.clear();
    this.drawCoverage.update(this.camera);
    this.shadowCoverage?.begin();
    this.matrixUpdates ??= new InstanceUpdates(this.instances[0].instanceMatrix);
    if (this.themeAttribute) this.themeUpdates ??= new InstanceUpdates(this.themeAttribute);
    for (const cell of this.cells) {
      const { row, lane } = cell;
      if (hidden.has(cellKey(cell))) continue;
      const x = (lane - 2) * COLUMN_SPACING - trackX;
      const y = -4.6 + field(row, lane) + hoverLift(cell) - this.presentationDrop(cell);
      const z = (row - 15.5) * ROW_SPACING + entryZ + this.rail.value;
      if (!fixed && !this.visibility.intersects(x, y, z)) continue;

      const slope = field(row + .5, lane) - field(row - .5, lane);
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(slope * .024 * (1 - detail), 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      if (play.enabled) this.relayPoints.set(cellKey(cell), { cell: { ...cell }, point: new THREE.Vector3(0, 3.5, 0).applyMatrix4(this.dummy.matrix) });
      this.shadowCoverage?.add(this.dummy.matrix);
      if (!this.drawCoverage.contains(x, y, z)) continue;
      const i = this.drawnCells.length;
      this.ensureInstanceCapacity(i + 1);
      this.drawnCells.push(cell);
      this.themeUpdates?.scalar(i, this.theme.sample(cell, time));
      this.matrixUpdates!.set(i * 16, this.dummy.matrix.elements);
    }
    const countChanged = this.instances[0].count !== this.drawnCells.length;
    const visibleMatricesChanged = this.matrixUpdates!.commit();
    const shadowMatricesChanged = this.shadowCoverage?.commit() ?? false;
    const matricesChanged = visibleMatricesChanged || shadowMatricesChanged;
    for (const inst of this.instances) {
      inst.count = this.drawnCells.length;
    }
    // Picking uses only the first instanced surface. The other batches disable
    // renderer culling and do not need an O(n) bound recomputation each frame.
    if (matricesChanged || countChanged || !this.instances[0].boundingSphere) this.instances[0].computeBoundingSphere();
    this.themeUpdates?.commit();
    let neighborTop = -Infinity;
    const lane = selectedLane,
      row = selectedRow;
    for (let r = row - 5; r <= row + 5; r++) {
      if (r !== row)
        neighborTop = Math.max(neighborTop, -4.6 + field(r, lane) + 3.76);
    }
    for (const o of this.outgoing) {
      if (o.cell.lane === lane && Math.abs(o.cell.row - row) <= 5) {
        neighborTop = Math.max(neighborTop, o.group.position.y + 3.76);
      }
    }
    this.clearance = this.model.position.y - neighborTop;
    this.canInspect =
      !cinematic &&
      Boolean(this.targetDetail) &&
      detail > 0.9 &&
      this.pulseGain < 0.01 &&
      this.clearance > 0.3;
    this.container.dataset.inspection =
      this.returnY !== null
        ? "aligning"
        : this.canInspect
          ? "ready"
          : this.targetDetail
            ? "lifting"
            : "preview";
    this.finishFrame(matricesChanged || Boolean(cinematic), this.model.position, detail);
  }
  /** Depth of field, the identical-frame check, the shadow map and the render itself (shared by the old grid and the stage). */
  private finishFrame(invalid: boolean, focus: THREE.Vector3, detail: number) {
    const fog = this.scene.fog as THREE.Fog;
    const focalPoint = focus
      .clone()
      .add(new THREE.Vector3(0, 2, 0))
      .applyMatrix4(this.camera.matrixWorldInverse);
    const bokehUniforms = this.bokeh.uniforms as Record<
      string,
      { value: number }
    >;
    bokehUniforms.focus.value = -focalPoint.z;
    // Deep space has no depth of field: seen through a long lens it is all in focus, and blurring the debris and the stars would
    // melt them into soft discs. The pass fades out with the world, and is not run at all once it is gone.
    const focused = (1 - this.deepSpace()) ** 2;
    this.bokeh.enabled = this.quality.depthOfField > 0 && focused > 0.01;
    bokehUniforms.aperture.value = (THREE.MathUtils.lerp(0.0003, 0.0008, detail) * this.quality.depthOfField * focused) / 100;
    this.cinema.update(this.filmAllowed ? this.deepSpace() : 0, performance.now() / 1000, this.camera.aspect);
    this.renderer.info.reset();
    // Keep all simulation and picking current. Reuse the composited canvas only
    // when its actual inputs are identical, including late textures and materials.
    const state = this.renderState;
    this.scene.updateMatrixWorld();
    // A changed instance buffer already proves the image changed. Avoid a
    // material/matrix snapshot on those busy frames; capture when it settles.
    if (invalid) {
      state.invalidate();
    } else {
      state.begin();
      state.floats(...this.camera.projectionMatrix.elements, ...this.camera.matrixWorldInverse.elements,
        ...this.camera.position.toArray(),
        fog.near, fog.far, this.themeAmount, this.subduedIndex.value,
        bokehUniforms.focus.value, bokehUniforms.aperture.value);
      this.scene.traverse(object => {
        state.add(object.id, Number(object.visible));
        if (!(object instanceof THREE.Mesh)) return;
        object.modelViewMatrix.multiplyMatrices(this.camera.matrixWorldInverse, object.matrixWorld);
        object.normalMatrix.getNormalMatrix(object.modelViewMatrix);
        state.floats(...object.modelViewMatrix.elements, ...object.normalMatrix.elements, ...object.matrixWorld.elements);
        state.add(object.geometry.id);
        // Some meshes have a list of materials (one per side) and the shader-drawn parts of the music world have no standard
        // material at all: read every field defensively. (Those shaders only show while the world animates, which always redraws.)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          const mat = material as Partial<THREE.MeshPhysicalMaterial>;
          // Three increments material.version for its own double-sided transmission
          // passes. Track application-controlled inputs, not that render-side counter.
          state.add(mat.uuid, mat.map?.uuid, mat.map?.version ?? 0);
          state.floats(
            mat.opacity ?? 0, mat.roughness ?? 0, mat.metalness ?? 0, mat.transmission ?? 0, mat.thickness ?? 0,
            mat.attenuationDistance ?? 0, mat.clearcoat ?? 0, mat.clearcoatRoughness ?? 0,
            mat.color?.r ?? 0, mat.color?.g ?? 0, mat.color?.b ?? 0,
            mat.attenuationColor?.r ?? 0, mat.attenuationColor?.g ?? 0, mat.attenuationColor?.b ?? 0);
        }
        for (const name of ['appearance', 'glassClarity', 'themeAmount', 'subduedIndex'])
          state.floats(object.userData[name]?.value ?? 0);
        if (object instanceof THREE.InstancedMesh)
          state.add(object.count, object.instanceMatrix.version, this.themeAttribute?.version ?? 0);
      });
      if (!state.end()) { this.reusedFrames++; return; }
    }
    this.renderedFrames++;
    const shadow = this.shadowState;
    shadow.begin();
    shadow.add(this.light.shadow.mapSize.x, Number(this.renderer.shadowMap.enabled));
    shadow.floats(...this.light.matrixWorld.elements, ...this.light.target.matrixWorld.elements);
    this.scene.traverseVisible(object => {
      if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
      shadow.add(object.id, object.geometry.id);
      shadow.floats(...object.matrixWorld.elements);
      if (object instanceof THREE.InstancedMesh) shadow.add(object.count, object.instanceMatrix.version);
    });
    this.renderer.shadowMap.needsUpdate = shadow.end() || this.light.shadow.needsUpdate;
    if (this.superPerformance) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
  projectCard(x: number, y: number) {
    this.model.updateMatrixWorld(true);
    const p = this.model
      .localToWorld(new THREE.Vector3(x, y, 0.255))
      .project(this.camera);
    return [(p.x + 1) * this.container.clientWidth / 2, (1 - p.y) * this.container.clientHeight / 2];
  }
  get decryptionFrame() { return this.decryption.frame; }
  finishDecryption() { this.decryption.finish(); }
  get detailVisibility() {
    return ease((this.detail - 0.25) / 0.55);
  }
  getStats() {
    this.model.updateMatrixWorld(true);
    const project = (x: number, y: number, z: number) => {
      const p = this.model
        .localToWorld(new THREE.Vector3(x, y, z))
        .project(this.camera);
      return [Math.round((p.x + 1) * this.container.clientWidth / 2), Math.round((1 - p.y) * this.container.clientHeight / 2)];
    };
    return {
      decryption: { ...this.decryption.frame, clarity: this.decryption.clarity, modelClarity: this.modelClarity() },
      topLeft: project(-2.5, 3.7, 0),
      topRight: project(2.5, 3.7, 0),
      labelTopLeft: project(-1.855, 3.27, 0.255),
      labelBottomLeft: project(-1.855, 2.81, 0.255),
      modelPosition: this.model.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraPosition: this.camera.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      fieldOfView: this.camera.fov,
      loaded: this.loaded,
      stageActive: this.stageOn,
      stage: this.stage?.describe() ?? null,
      drawCalls: this.renderer.info.render.calls,
      renderedFrames: this.renderedFrames,
      reusedFrames: this.reusedFrames,
      superPerformance: this.superPerformance,
      presentation: this.presence,
      triangles: this.renderer.info.render.triangles,
      archiveCount: this.drawnCells.length,
      archiveCandidates: this.cells.length,
      archiveCulled: this.cells.length - this.drawnCells.length,
      archiveCapacity: this.instanceCapacity,
      archiveCoverage: this.extraCoverage ? "extra" : "standard",
      returningFiles: this.outgoing.length,
      selectionPhase: this.pendingPulse
        ? "lifting"
        : this.pulses.length
          ? "wave"
          : "settled",
      pendingPulse: this.pendingPulse ? { ...this.pendingPulse } : null,
      pulses: this.pulses.map((pulse) => ({ ...pulse })),
      referenceTime: Math.round((this.scanTime + 5) * 100) / 100,
      selectedSlot: this.selectedSlot,
      selectedLane: Math.floor(this.selectedSlot / 32),
      selectedCell: { ...this.selectedCell },
      hoverCell: this.hoverCell ? { ...this.hoverCell } : null,
      hoverLifts: Object.fromEntries(this.hoverLifts),
      dragTrack: this.dragTrack ? { ...this.dragTrack } : null,
      archiveMomentum: this.archiveMomentum ? {
        phase: this.archiveMomentum.motion.phase,
        value: this.archiveMomentum.motion.value,
        velocity: this.archiveMomentum.motion.velocity,
      } : null,
      holdingArchive: this.holdingArchive,
      dragProjection: this.dragProjection(),
      dragMapping: this.archiveDrag.active ? "free" : null,
      coordinateOrigin: { ...this.coordinateOrigin },
      poolBounds: {
        minLane: Math.min(...this.cells.map((c) => c.lane)),
        maxLane: Math.max(...this.cells.map((c) => c.lane)),
        minRow: Math.min(...this.cells.map((c) => c.row)),
        maxRow: Math.max(...this.cells.map((c) => c.row)),
      },
      laneFocus: this.laneFocus.value,
      columnCamera: this.columnCamera.value,
      rotation: this.rotation,
      clearance: this.clearance,
      canInspect: this.canInspect,
      returnPhase: this.returnY !== null ? "aligning" : "lowering",
      extraction: Math.round(this.lift.value * 1000) / 1000,
      appearance: Math.round(ease(this.lift.value / 0.4) * 1000) / 1000,
      cameraDetail: Math.round(this.detail * 1000) / 1000,
      idleGain: this.idleGain,
      flatten: this.flatMix,
      spectrumActivity: this.playfield.bands.activity,
      selectedIndexDim: this.model.children.find(child => child.userData.surface === "Index_Inlay")?.userData.subduedIndex?.value,
      returningIndexDims: this.outgoing.map(o => ({ cell: o.cell, dim: o.group.children.find(child => child.userData.surface === "Index_Inlay")?.userData.subduedIndex?.value })),
      cameraDistance: this.camera.position.distanceTo(this.cameraAim),
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      fogNear: (this.scene.fog as THREE.Fog).near,
      fogFar: (this.scene.fog as THREE.Fog).far,
      returningAppearance: this.outgoing.map((o) => ({
        slot: o.slot,
        clarity: o.group.children.find(child => child.userData.surface === "Frosted_Polymer")?.userData.glassClarity?.value,
        cell: { ...o.cell },
        lift: o.lift.value,
        quality: ease(o.lift.value / 0.4),
        rotation: o.group.rotation.y,
        worldY: o.group.position.y,
        phase: o.returnY !== null ? "aligning" : "lowering",
      })),
      rail: Math.round(this.rail.value * 1000) / 1000,
    };
  }
}
