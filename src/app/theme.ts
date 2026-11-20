/**
 * Light / dark palette, painted onto the document's CSS variables.
 *
 * The 3D scene runs its own per-cassette wave (ThemeWave) when the theme flips; `paint(amount)` is fed the scene's
 * background amount every frame, so the interface and the glass cross-fade together. Without a scene the page runs a
 * short transition of its own.
 */

export type ThemeSetting = "auto" | "light" | "dark";

const PALETTE = {
  ink: ["#080a08", "#f0f4f0"],
  muted: ["#77756d", "#a2b7b8"],
  line: ["#aaa59a", "#34484b"],
  paper: ["#eae5e1", "#060b0d"],
  panel: ["#edebe4", "#111a1d"],
  field: ["#e7e3d9", "#18262a"],
  glass: ["#f6f2eb", "#0d181b"],
  "glass-strong": ["#fffdf8", "#1b2c30"],
  rim: ["#ffffff", "#bce3dc"],
  accent: ["#1f9e8e", "#58f1d3"],
  "accent-ink": ["#157060", "#86f7e2"],
  "on-accent": ["#ffffff", "#031411"],
  danger: ["#b03a2e", "#ff877b"],
  "on-danger": ["#ffffff", "#2a0c08"],
  warn: ["#b27618", "#ffc15f"],
  ok: ["#288254", "#6fe0a2"],
} as const;

type Rgb = [number, number, number];
const parse = (hex: string): Rgb => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const TABLE = Object.entries(PALETTE).map(([name, [light, dark]]) => ({ name, from: parse(light), to: parse(dark) }));
/** Variables that also get an "-rgb" companion for rgba() use. */
const WITH_RGB = new Set(["ink", "paper", "panel", "glass", "glass-strong", "rim", "accent", "danger", "warn", "ok"]);

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
