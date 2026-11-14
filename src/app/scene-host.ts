import type { ArchiveStage, StageItem, StageLayout } from "../archive-stage";
import type { ArchiveCell, ArchiveNavigation } from "../archive-loop";
import { records, setArchive } from "../data";
import { fullMotion, reducedMotion } from "../motion-preferences";
import { normalizeQuality, qualityPresets, type RenderQuality } from "../render-quality";
import { ArchiveScene } from "../scene";
import { createFacePainter } from "./faces";
import { labelFontSample, paintLabel } from "./label";
import type { QualityTier } from "./perf-policy";
import { buildArchive, reselect } from "./records";
import { ringItems } from "./stage-items";
import type { InstanceSummary } from "./types";

/**
 * Owns the lifetime of the 3D scene: creating it (and falling back gracefully when WebGL is unavailable), giving it back
 * to the GPU while a game runs behind a hidden launcher, rebuilding it afterwards, and keeping the shelf's contents in
 * step with the instance list. Everything else talks to the scene through here.
 */

export type SceneMode = "archive" | "detail";
export type SceneStatus = "off" | "loading" | "ready" | "failed";

/** What each quality tier asks of the GPU (see render-quality.ts for the meaning of the fields). */
export const TIER_QUALITY: Record<QualityTier, RenderQuality> = {
  high: normalizeQuality(qualityPresets.original),
  medium: normalizeQuality({ scale: 90, pixelRatio: 1, antialias: "off", shadows: 2048, aoSamples: 16, aoResolution: 0.5, depthOfField: 60, transmission: 0.75, anisotropy: 8 }),
  low: normalizeQuality(qualityPresets.performance),
  minimal: normalizeQuality({ ...qualityPresets.performance, scale: 60, shadows: 0, anisotropy: 1 }),
};

export interface SceneCallbacks {
  select(index: number, cell?: ArchiveCell): void;
  navigate(axis: "row" | "lane", direction: number): void;
  hover(index: number | null): void;
}

/** What the 3D stage reports (the Möbius ring on the home view, the single row of the download view). */
export interface StageHandlers {
  /** The selection moved (a click, the wheel, a drag). */
  select(index: number): void;
  /** The already selected archive was clicked. */
  activate(index: number): void;
  /** A button printed on the pulled-out archive was clicked. */
  action(id: string, index: number): void;
  /** The row is nearly at its end: more content is wanted. */
  more(): void;
}

/** Name of the GPU the browser would use (software rasterisers are recognised by the governor). */
export function detectRendererName(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "no-webgl";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    // Do not force-lose this probe context: on some recent NVIDIA drivers the asynchronous loss races the real
    // renderer's context creation and makes the whole 3D stage fail. The tiny canvas is collectable on its own.
    return name;
  } catch {
    return "unknown";
  }
}

export class SceneHost {
  scene?: ArchiveScene;
  status: SceneStatus = "off";
  error?: string;
  tier: QualityTier = "medium";
  /** Index of the selected record in the shelf. */
  index = 0;
  private mode: SceneMode = "archive";
  private dark = false;
  private reduced = false;
  private loading?: Promise<boolean>;
  private disposed = false;
  private fontsReady?: Promise<unknown>;
  /** The stage's reaction handlers; set by the app. */
  stageHandlers: Partial<StageHandlers> = {};
  /** What the stage shows, kept here so that a scene that was given back to the GPU and rebuilt gets the same picture again. */
  private picture: { layout: StageLayout; items: StageItem[]; selected: number; detail: boolean } = { layout: "ring", items: [], selected: 0, detail: false };
  /** The items of the home ring (the shelf's records), kept while the download row is shown. */
  private ring: StageItem[] = [];
  private echo = false;
  private readonly fontChars = new Set<string>();

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: SceneCallbacks,
  ) {}

  get ready(): boolean {
    return this.status === "ready" && !!this.scene;
  }

  /** Create the scene if it does not exist. Resolves true when it can be drawn. */
  ensure(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.loading) return this.loading;
    this.loading = this.create().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private loadFonts(): Promise<unknown> {
    // The printed label uses MiSans; make sure the shards holding its characters are in before the first paint.
    this.fontsReady ??= Promise.race([
      Promise.all(["300", "400", "700"].map((weight) => document.fonts.load(`${weight} 40px MiSans`, labelFontSample()))),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]).catch(() => undefined);
    return this.fontsReady;
  }

  private async create(): Promise<boolean> {
    this.status = "loading";
    this.error = undefined;
    await this.loadFonts();
    // Most machines get the full-quality context. Some newer GPU drivers reject the high-performance/MSAA request
    // specifically; retry with a conservative default context before giving up and showing the DOM-only view.
    const profiles: { label: string; options: { antialias?: boolean; powerPreference?: WebGLPowerPreference } }[] = [
      { label: "high-performance", options: {} },
      { label: "compatibility", options: { antialias: false, powerPreference: "default" } },
    ];
    let lastError: unknown;
    for (const profile of profiles) {
      let next: ArchiveScene | undefined;
      try {
        next = new ArchiveScene(this.container, undefined, false, "baseline", profile.options);
        next.renderer.domElement.style.opacity = "0";
        next.setPresentationVisible(false, true);
        next.labelPainter = paintLabel;
        await next.load();
        if (this.disposed) {
          next.dispose();
          return false;
        }
        next.setMotion(this.reduced ? reducedMotion() : fullMotion());
        next.setQuality(TIER_QUALITY[this.tier]);
        next.setSuperPerformance(this.tier === "minimal");
        next.setMode(this.mode);
        next.setTheme(this.dark, true);
        next.onSelect = (index, cell) => this.callbacks.select(index, cell);
        next.onNavigate = (axis, direction) => this.callbacks.navigate(axis, direction);
        next.onHover = (index) => this.callbacks.hover(index);
        next.select(this.index);
        next.revealImmediately();
        this.installStage(next);
        this.scene = next;
        this.status = "ready";
        return true;
      } catch (error) {
        lastError = error;
        console.warn(`[vitrine] 3D context ${profile.label} failed`, error);
        try {
          next?.dispose();
        } catch {
          /* half-built scene */
        }
      }
    }
    console.error("3D scene unavailable", lastError);
    this.scene = undefined;
    this.status = "failed";
    this.error = (lastError as Error)?.message ?? String(lastError);
    return false;
  }

  /** Give the GPU everything back. The shelf contents and selection are kept; `ensure()` rebuilds the scene. */
  release() {
    const scene = this.scene;
    if (!scene) return;
    this.scene = undefined;
    this.status = "off";
    try {
      scene.dispose();
    } catch (error) {
      console.error("scene dispose failed", error);
    }
  }

  dispose() {
    this.disposed = true;
    this.release();
  }

  /** Build the 3D stage inside a new scene; if that fails the plain shelf is still usable. */
  private installStage(scene: ArchiveScene) {
    try {
      const stage = scene.installStage(createFacePainter());
      stage.events = {
        select: (index) => {
          if (!this.echo) this.stageHandlers.select?.(index);
        },
        activate: (index) => this.stageHandlers.activate?.(index),
        action: (id, index) => this.stageHandlers.action?.(id, index),
        more: () => this.stageHandlers.more?.(),
      };
      stage.setDark(this.dark);
      scene.setStageLocked(this.mode === "detail");
      scene.setStageActive(true);
      stage.setItems(this.picture.layout, this.picture.items, this.picture.selected);
      stage.setDetail(this.picture.detail && this.picture.layout === "ring");
    } catch (error) {
      console.error("3D stage unavailable, using the plain shelf", error);
    }
  }

  /** The 3D stage of the live scene (undefined without a scene, or when the stage could not be built). */
  get stage(): ArchiveStage | undefined {
    return this.scene?.stageActive ? this.scene.stageHandle : undefined;
  }

  get layout(): StageLayout {
    return this.picture.layout;
  }

  /** Home: the Möbius ring of the shelf's archives. From the download row this regroups the same archives into the ring. */
  showRing() {
    this.picture = { layout: "ring", items: this.ring, selected: this.index, detail: false };
    this.stage?.setItems("ring", this.ring, this.index);
    this.stage?.setDetail(false);
  }

  /** The download view: one row of archives. From the ring this regroups the ring's archives into the row. */
  showRow(items: StageItem[], selected = 0) {
    this.picture = { layout: "row", items, selected, detail: false };
    this.stage?.setDetail(false);
    this.stage?.setItems("row", items, selected);
  }

  /** The category switch inside the download view: the cards are pulled apart, new ones fly in (null: still waiting for them). */
  swapRow(items: StageItem[] | null) {
    if (items) this.picture.items = items;
    this.picture.selected = 0;
    this.stage?.swapItems(items);
  }

  /** The real results replace the blanks a row was filled with while they were on their way. */
  replaceRow(items: StageItem[]) {
    this.picture.items = items;
    this.stage?.replaceItems(items);
  }

  appendRow(items: StageItem[]) {
    this.picture.items = this.picture.items.concat(items);
    this.stage?.appendItems(items);
  }

  updateRow(index: number, item: StageItem) {
    if (index >= 0 && index < this.picture.items.length) this.picture.items[index] = item;
    this.stage?.updateItem(index, item);
  }

  selectRow(index: number) {
    this.picture.selected = index;
    this.echo = true;
    try {
      this.stage?.select(index);
    } finally {
      this.echo = false;
    }
  }

  /** Make sure the font shards that hold `text` are in, then print the faces again (canvas text does not wait for fonts). */
  async preloadFonts(text: string) {
    const fresh = [...new Set(text)].filter((char) => char.trim() && !this.fontChars.has(char));
    if (!fresh.length) return;
    for (const char of fresh) this.fontChars.add(char);
    const sample = fresh.join("");
    try {
      await Promise.race([Promise.all(["400", "700"].map((weight) => document.fonts.load(`${weight} 24px MiSans`, sample))), new Promise((resolve) => setTimeout(resolve, 2500))]);
    } catch {
      /* the fallback font is fine */
    }
    this.stage?.repaintAll();
  }

  /** Print the home ring's faces again after the facts changed (a game started, a favourite was toggled). */
  refreshRing() {
    this.ring = ringItems(records);
    if (this.picture.layout !== "ring") return;
    this.picture.items = this.ring;
    this.picture.selected = this.index;
    this.stage?.setItems("ring", this.ring, this.index);
  }

  // ------------------------------------------------------------------------------------------ state mirrored into the scene

  present(visible: boolean, immediate = false) {
    this.scene?.setPresentationVisible(visible, immediate);
  }

  setMode(mode: SceneMode) {
    this.mode = mode;
    this.scene?.setMode(mode);
    this.picture.detail = mode === "detail";
    this.scene?.setStageLocked(mode === "detail");
    this.stage?.setDetail(mode === "detail" && this.picture.layout === "ring");
  }

  setDark(dark: boolean, immediate = false) {
    this.dark = dark;
    this.scene?.setTheme(dark, immediate);
    // The printed faces follow the glass: a moment after the colour wave has started.
    const stage = this.stage;
    if (!stage) return;
    if (immediate) stage.setDark(dark);
    else setTimeout(() => this.dark === dark && this.stage === stage && stage.setDark(dark), 320);
  }

  setReducedMotion(reduced: boolean) {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    this.scene?.setMotion(reduced ? reducedMotion() : fullMotion());
  }

  setTier(tier: QualityTier) {
    this.tier = tier;
    const scene = this.scene;
    if (!scene) return;
    scene.setSuperPerformance(tier === "minimal");
    scene.setQuality(TIER_QUALITY[tier]);
  }

  resize() {
    this.scene?.resize();
  }

  select(index: number, navigation?: ArchiveNavigation) {
    this.index = index;
    const stage = this.stage;
    if (!stage) return void this.scene?.select(index, navigation);
    // The ring follows the selection; in the download row the record selection is only remembered for the way back.
    if (this.picture.layout !== "ring") return;
    this.picture.selected = index;
    this.echo = true;
    try {
      stage.select(index);
    } finally {
      this.echo = false;
    }
  }

  /** Redraw the printed label (a rename, or a font that arrived late). */
  refreshLabel() {
    this.scene?.refreshLabel();
  }

  /**
   * The instance list changed: rebuild the shelf and keep the selection on the same instance (or its neighbour).
   * Returns the index that is selected afterwards.
   */
  setInstances(instances: InstanceSummary[], previous?: { id: string; index: number }): number {
    const archive = buildArchive(instances);
    setArchive(archive);
    this.index = reselect(previous, archive.records);
    this.ring = ringItems(archive.records);
    if (this.picture.layout === "ring") {
      this.picture.items = this.ring;
      this.picture.selected = this.index;
    }
    if (this.stage) {
      if (this.picture.layout === "ring") this.stage.setItems("ring", this.ring, this.index);
    } else {
      this.scene?.select(this.index);
      this.scene?.refreshLabel();
    }
    return this.index;
  }
}
