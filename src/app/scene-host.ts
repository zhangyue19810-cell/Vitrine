import type { ArchiveCell, ArchiveNavigation } from "../archive-loop";
import { setArchive } from "../data";
import { fullMotion, reducedMotion } from "../motion-preferences";
import { normalizeQuality, qualityPresets, type RenderQuality } from "../render-quality";
import { ArchiveScene } from "../scene";
import { labelFontSample, paintLabel } from "./label";
import type { QualityTier } from "./perf-policy";
import { buildArchive, reselect } from "./records";
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

/** Name of the GPU the browser would use (software rasterisers are recognised by the governor). */
export function detectRendererName(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "no-webgl";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
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
    let next: ArchiveScene | undefined;
    try {
      await this.loadFonts();
      next = new ArchiveScene(this.container);
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
      this.scene = next;
      this.status = "ready";
      return true;
    } catch (error) {
      console.error("3D scene unavailable", error);
      try {
        next?.dispose();
      } catch {
        /* half-built scene */
      }
      this.scene = undefined;
      this.status = "failed";
      this.error = (error as Error)?.message ?? String(error);
      return false;
    }
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

  // ------------------------------------------------------------------------------------------ state mirrored into the scene

  present(visible: boolean, immediate = false) {
    this.scene?.setPresentationVisible(visible, immediate);
  }

  setMode(mode: SceneMode) {
    this.mode = mode;
    this.scene?.setMode(mode);
  }

  setDark(dark: boolean, immediate = false) {
    this.dark = dark;
    this.scene?.setTheme(dark, immediate);
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
    this.scene?.select(index, navigation);
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
    this.scene?.select(this.index);
    this.scene?.refreshLabel();
    return this.index;
  }
}
