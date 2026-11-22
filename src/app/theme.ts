/**
 * Light / dark palette, painted onto the document's CSS variables.
 *
 * The dark palette is the deep-space look of the launcher: near-black paper, warm white ink, gold accent.
 * The 3D scene runs its own per-cassette wave (ThemeWave) when the theme flips; `paint(amount)` is fed the scene's
 * background amount every frame, so the interface and the glass cross-fade together. Without a scene the page runs a
 * short transition of its own.
 */

export type ThemeSetting = "auto" | "light" | "dark";

const PALETTE = {
  ink: ["#080a08", "#ece5d6"],
  muted: ["#77756d", "#8f897c"],
  line: ["#aaa59a", "#3e392f"],
  paper: ["#eae5e1", "#050507"],
  panel: ["#edebe4", "#0e0e11"],
  field: ["#e7e3d9", "#17171b"],
  accent: ["#b27a22", "#e8b967"],
  "accent-ink": ["#80530f", "#f4d08f"],
  "on-accent": ["#ffffff", "#1a1205"],
  danger: ["#b03a2e", "#ff8d78"],
  "on-danger": ["#ffffff", "#2a0c08"],
  warn: ["#b27618", "#e9b45a"],
  ok: ["#288254", "#7fd3a0"],
} as const;

type Rgb = [number, number, number];
const parse = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const TABLE = Object.entries(PALETTE).map(([name, [light, dark]]) => ({ name, from: parse(light), to: parse(dark) }));
/** Variables that also get an "-rgb" companion for rgba() use. */
const WITH_RGB = new Set(["ink", "paper", "panel", "accent"]);

let painted = -1;

export function paint(amount: number) {
  const t = Math.max(0, Math.min(1, amount));
  if (Math.abs(t - painted) < 0.0005) return;
  painted = t;
  const style = document.documentElement.style;
  for (const { name, from, to } of TABLE) {
    const rgb = from.map((v, i) => Math.round(v + (to[i] - v) * t)).join(", ");
    style.setProperty(`--${name}`, `rgb(${rgb})`);
    if (WITH_RGB.has(name)) style.setProperty(`--${name}-rgb`, rgb);
  }
  document.documentElement.dataset.darkSurface = String(t > 0.5);
}

export function systemPrefersDark(): boolean {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(setting: ThemeSetting): boolean {
  return setting === "dark" || (setting === "auto" && systemPrefersDark());
}

/** A page-only cross-fade for when there is no 3D scene to drive `paint`. */
export class ThemeFader {
  private raf = 0;
  private current = 0;

  get amount() {
    return this.current;
  }

  /** Note where the palette is (painted by someone else, e.g. the 3D scene) without painting or animating. */
  follow(amount: number) {
    cancelAnimationFrame(this.raf);
    this.current = amount;
  }

  set(dark: boolean, immediate = false) {
    cancelAnimationFrame(this.raf);
    const target = dark ? 1 : 0;
    if (immediate || Math.abs(target - this.current) < 0.001) {
      this.current = target;
      paint(target);
      return;
    }
    const from = this.current;
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / 650);
      const eased = k * k * (3 - 2 * k);
      this.current = from + (target - from) * eased;
      paint(this.current);
      if (k < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}
