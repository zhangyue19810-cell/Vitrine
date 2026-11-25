import type { Bridge } from "./bridge";
import { store } from "./store";
import { visualPreferences, type BackgroundSettings, type VisualPreferencesState } from "./visuals";

/**
 * The wallpaper layer behind the 3D vitrine.
 *
 * The media is deliberately kept behind the renders. In wallpaper mode the
 * canvas is composited with `screen`, so the near-black WebGL clear colour
 * disappears and the Möbius ring floats over the picture; the DOM glass above
 * then samples the combined result. A tiny sampled frame gives the UI its
 * adaptive accent, while pointer parallax and a focus vignette supply the
 * depth without a heavy per-pixel depth pass.
 */

type Rgb = [number, number, number];
export type WallpaperMedia = HTMLImageElement | HTMLVideoElement;

export interface BackgroundCallbacks {
  /** Hand the loaded media to the WebGL scene (null when it becomes unavailable). */
  media(media: WallpaperMedia | null, aspect: number): void;
  look(settings: BackgroundSettings): void;
}

const SAMPLE_W = 40;
const SAMPLE_H = 24;
const PALETTE_INTERVAL_MS = 12_000;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

function setRgb(style: CSSStyleDeclaration, name: string, value: Rgb) {
  style.setProperty(name, `${value[0]}, ${value[1]}, ${value[2]}`);
}

export class BackgroundView {
  private readonly layer = document.createElement("div");
  private readonly offs: (() => void)[] = [];
  private current?: WallpaperMedia;
  private video?: HTMLVideoElement;
  private objectUrl?: string;
  private sampleTimer?: ReturnType<typeof setInterval>;
  private sampleFrame = 0;
  private generation = 0;
  private disposed = false;
  private pointerFrame = 0;
  private pointer = { x: 0, y: 0 };
  private state: VisualPreferencesState;
  private mediaReady = false;
  private windowActive = document.hasFocus();

  constructor(
    private readonly stage: HTMLElement,
    private readonly bridge: Bridge | undefined,
    private readonly callbacks: BackgroundCallbacks,
  ) {
    this.layer.className = "stage-wallpaper";
    this.layer.setAttribute("aria-hidden", "true");
    this.layer.innerHTML = '<div class="wallpaper-media"></div><div class="wallpaper-depth"></div><div class="wallpaper-veil"></div><div class="wallpaper-grain"></div>';
    stage.prepend(this.layer);
    this.state = visualPreferences.get();
    this.offs.push(visualPreferences.subscribe((next) => {
      const previous = this.state.background;
      this.state = next;
      this.applyCss();
      if (previous.kind !== next.background.kind || previous.path !== next.background.path) void this.apply();
      else if (previous.paused !== next.background.paused) this.syncPlayback();
    }));
    this.offs.push(store.on("games", () => this.syncPlayback()));
    const onVisibility = () => this.syncPlayback();
    document.addEventListener("visibilitychange", onVisibility);
    this.offs.push(() => document.removeEventListener("visibilitychange", onVisibility));
    const onFocus = () => {
      this.windowActive = true;
      this.syncPlayback();
    };
    const onBlur = () => {
      this.windowActive = false;
      this.syncPlayback();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    this.offs.push(() => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    });
    this.offs.push(this.bindParallax());
    void this.apply();
  }

  private get settings(): BackgroundSettings {
    return this.state.background;
  }

  private mediaHost(): HTMLElement {
    return this.layer.firstElementChild as HTMLElement;
  }

  private applyCss() {
    const background = this.settings;
    this.layer.dataset.kind = background.kind;
    this.layer.style.setProperty("--wallpaper-dim", String(background.dim));
    this.layer.style.setProperty("--wallpaper-blur", `${background.blur.toFixed(1)}px`);
    this.layer.style.setProperty("--wallpaper-scale", String(1.025 + background.depth * 0.055));
    this.layer.style.setProperty("--wallpaper-depth", String(background.depth));
    this.layer.style.setProperty("--wallpaper-focus", `${(4 + background.depth * 9).toFixed(1)}%`);
    this.stage.dataset.wallpaper = background.kind === "none" ? "false" : "true";
    document.documentElement.dataset.wallpaper = background.kind === "none" ? "false" : background.kind;
    this.callbacks.look(background);
  }

  private async mediaUrl(path: string): Promise<string | undefined> {
    if (!path) return undefined;
    if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
    if (!this.bridge?.mediaUrl) return undefined;
    return (await this.bridge.mediaUrl(path)) ?? undefined;
  }

  private async apply() {
    const generation = ++this.generation;
    this.applyCss();
    this.cleanupMedia();
    const background = this.settings;
    if (background.kind === "none" || !background.path) {
      this.clearPalette();
      return;
    }
    const url = await this.mediaUrl(background.path).catch(() => undefined);
    if (!url || generation !== this.generation || this.disposed) {
      this.layer.dataset.error = "true";
      this.clearPalette();
      return;
    }
    delete this.layer.dataset.error;
    const host = this.mediaHost();
    this.mediaReady = false;
    if (background.kind === "video") {
      const video = document.createElement("video");
      video.className = "wallpaper-video";
      video.crossOrigin = "anonymous";
      video.loop = true;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = "auto";
      video.disablePictureInPicture = true;
      video.addEventListener("loadeddata", () => {
        if (generation !== this.generation) return;
        this.mediaReady = true;
        this.emitMedia(video);
        this.schedulePalette(180);
        this.syncPlayback();
      }, { once: true });
      video.addEventListener("error", () => {
        if (generation === this.generation) this.layer.dataset.error = "true";
      }, { once: true });
      host.append(video);
      this.current = video;
      this.video = video;
      video.src = url;
      video.load();
      this.sampleTimer = setInterval(() => this.schedulePalette(0), PALETTE_INTERVAL_MS);
      this.schedulePalette(400);
    } else {
      const image = new Image();
      image.className = "wallpaper-image";
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.alt = "";
      image.addEventListener("load", () => {
        if (generation !== this.generation) return;
        this.mediaReady = true;
        this.emitMedia(image);
        this.schedulePalette(0);
      }, { once: true });
      image.addEventListener("error", () => {
        if (generation === this.generation) this.layer.dataset.error = "true";
      }, { once: true });
      host.append(image);
      this.current = image;
      image.src = url;
    }
    this.syncPlayback();
  }

  private emitMedia(media: WallpaperMedia | null) {
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media instanceof HTMLImageElement ? media.naturalWidth : 0;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media instanceof HTMLImageElement ? media.naturalHeight : 0;
    this.callbacks.media(media, width > 0 && height > 0 ? width / height : 16 / 9);
  }

  private schedulePalette(delay: number) {
    cancelAnimationFrame(this.sampleFrame);
    this.sampleFrame = requestAnimationFrame(() => {
      if (delay > 0) {
        window.setTimeout(() => {
          if (!this.disposed) this.samplePalette();
        }, delay);
      } else this.samplePalette();
    });
  }

  private samplePalette() {
    const media = this.current;
    if (!media || !this.mediaReady || this.disposed || document.hidden || store.gameRunning) return;
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (width < 2 || height < 2) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_W;
      canvas.height = SAMPLE_H;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(media, 0, 0, SAMPLE_W, SAMPLE_H);
      const pixels = context.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const samples: { r: number; g: number; b: number; s: number; l: number }[] = [];
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 48) continue;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        ar += r;
        ag += g;
        ab += b;
        count++;
        const [, s, l] = rgbToHsl(r, g, b);
        if (l > 0.06 && l < 0.96 && s > 0.1) samples.push({ r, g, b, s, l });
      }
      if (!count) return;
      samples.sort((a, b) => b.s * (0.5 + b.l) - a.s * (0.5 + a.l));
      const top = samples.slice(0, Math.max(8, Math.min(72, Math.floor(samples.length * 0.14))));
      let vr = ar / count;
      let vg = ag / count;
      let vb = ab / count;
      if (top.length) {
        let wr = 0;
        let wg = 0;
        let wb = 0;
        let total = 0;
        for (const sample of top) {
          const weight = 0.15 + sample.s * sample.s * (0.4 + sample.l);
          wr += sample.r * weight;
          wg += sample.g * weight;
          wb += sample.b * weight;
          total += weight;
        }
        if (total) {
          vr = wr / total;
          vg = wg / total;
          vb = wb / total;
        }
      }
      let [h, s, l] = rgbToHsl(vr, vg, vb);
      if (s < 0.12) {
        // Nearly monochrome wallpapers still get a readable glass highlight:
        // derive a restrained gold/cyan temperature from their luminance.
        h = l > 0.5 ? 38 : 205;
        s = 0.28;
      }
      const accent = hslToRgb(h, clamp(s * 1.28, 0.38, 0.76), clamp(l * 0.68 + 0.32, 0.54, 0.7));
      const flowA = hslToRgb(h + 38, clamp(s * 0.92, 0.3, 0.65), 0.64);
      const flowB = hslToRgb(h - 52, clamp(s * 0.8, 0.22, 0.58), 0.58);
      const deep = hslToRgb(h, clamp(s * 0.72, 0.16, 0.45), 0.16);
      const style = document.documentElement.style;
      setRgb(style, "--ambient-accent-rgb", accent);
      setRgb(style, "--ambient-flow-a-rgb", flowA);
      setRgb(style, "--ambient-flow-b-rgb", flowB);
      setRgb(style, "--ambient-depth-rgb", deep);
      style.setProperty("--ambient-accent", `rgb(${accent.join(", ")})`);
      document.documentElement.dataset.adaptiveBackground = "true";
    } catch {
      // Cross-origin video frames can be unavailable even with CORS; the CSS
      // fallback keeps the existing black-gold palette, which is safe.
      this.clearPalette();
    }
  }

  private clearPalette() {
    const style = document.documentElement.style;
    for (const name of ["--ambient-accent-rgb", "--ambient-flow-a-rgb", "--ambient-flow-b-rgb", "--ambient-depth-rgb", "--ambient-accent"]) style.removeProperty(name);
    document.documentElement.dataset.adaptiveBackground = "false";
  }

  private syncPlayback() {
    const video = this.video;
    if (!video) return;
    const shouldPause = this.disposed || this.settings.paused || store.gameRunning || document.hidden || !this.windowActive;
    if (shouldPause) {
      if (!video.paused) video.pause();
    } else if (video.paused && video.readyState >= 2) {
      void video.play().catch(() => undefined);
    }
  }

  private bindParallax(): () => void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => undefined;
    const move = (event: PointerEvent) => {
      if (this.settings.kind === "none" || this.settings.depth <= 0.02 || store.gameRunning || document.hidden) return;
      if (this.pointerFrame) return;
      this.pointerFrame = requestAnimationFrame(() => {
        this.pointerFrame = 0;
        const nx = event.clientX / Math.max(1, innerWidth) * 2 - 1;
        const ny = event.clientY / Math.max(1, innerHeight) * 2 - 1;
        const depth = this.settings.depth;
        this.layer.style.setProperty("--wallpaper-pan-x", `${(-nx * 12 * depth).toFixed(2)}px`);
        this.layer.style.setProperty("--wallpaper-pan-y", `${(-ny * 8 * depth).toFixed(2)}px`);
      });
    };
    const leave = () => {
      this.layer.style.setProperty("--wallpaper-pan-x", "0px");
      this.layer.style.setProperty("--wallpaper-pan-y", "0px");
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(this.pointerFrame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", leave);
    };
  }

  private cleanupMedia() {
    clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
    cancelAnimationFrame(this.sampleFrame);
    this.video?.pause();
    this.video?.removeAttribute("src");
    this.video?.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.video = undefined;
    this.current = undefined;
    this.mediaReady = false;
    this.mediaHost().replaceChildren();
    this.callbacks.media(null, 16 / 9);
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    this.cleanupMedia();
    for (const off of this.offs.splice(0)) off();
    this.layer.remove();
    this.clearPalette();
  }
}
