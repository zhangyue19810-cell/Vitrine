/**
 * The stage is a fixed-design surface (about 1350 × 760 "virtual pixels") that is scaled to the window, so every control
 * keeps its proportions from a small window to a 4K display. The scale can be nudged in the settings (0.75 – 1.5).
 */

export interface LayoutState {
  /** Real pixels per virtual pixel. */
  scale: number;
  /** Size of the stage in virtual pixels. */
  width: number;
  height: number;
  /** A small window: sheets drop their side padding and two-column pages collapse to one. */
  compact: boolean;
}

const REF_W = 1280;
const REF_H = 760;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.75;

export function computeLayout(viewportWidth: number, viewportHeight: number, uiScale = 1): LayoutState {
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  const fit = Math.min(vw / REF_W, vh / REF_H);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)) * Math.min(1.5, Math.max(0.75, uiScale));
  const width = vw / scale;
  const height = vh / scale;
  return { scale, width, height, compact: width < 1180 || height < 640 };
}

export class Layout {
  state: LayoutState;
  private uiScale = 1;
  private frame = 0;
  private readonly observer: ResizeObserver;
  /** Called after the stage was resized (the 3D scene needs `resize()`). */
  onChange?: (state: LayoutState) => void;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly stage: HTMLElement,
  ) {
    this.state = computeLayout(viewport.clientWidth, viewport.clientHeight);
    this.apply();
    // One resize per animation frame at most: dragging a window edge fires dozens of events.
    this.observer = new ResizeObserver(() => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.update();
      });
    });
    this.observer.observe(viewport);
  }

  setUiScale(scale: number) {
    if (this.uiScale === scale) return;
    this.uiScale = scale;
    this.update();
  }

  update() {
    const next = computeLayout(this.viewport.clientWidth, this.viewport.clientHeight, this.uiScale);
    const same = Math.abs(next.scale - this.state.scale) < 1e-4 && Math.abs(next.width - this.state.width) < 0.5 && Math.abs(next.height - this.state.height) < 0.5;
    this.state = next;
    if (same) return;
    this.apply();
    this.onChange?.(next);
  }

  /** Convert a pointer position (client pixels) to stage coordinates (virtual pixels). */
  toStage(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.stage.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.state.scale, y: (clientY - rect.top) / this.state.scale };
  }

  dispose() {
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
  }

  private apply() {
    const { width, height, scale, compact } = this.state;
    const stage = this.stage;
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    stage.dataset.compact = String(compact);
    // The 3D scene reads this to choose its camera framing (see viewport-layout.ts).
    this.viewport.dataset.layout = compact ? "compact" : "desktop";
  }
}
