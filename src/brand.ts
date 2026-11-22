/**
 * Vitrine · 琉匣 — the mark is the lemniscate of the home screen's ring, drawn as two loops of glass that interlock: the left
 * one clear (warm white), the right one tinted (gold), the way the display case holds a clear and a tinted pane.
 */

const INK = "currentColor";
const ACCENT = "var(--accent, #e8b967)";

/** The two loops, on a 256 × 256 canvas; both start and end at the crossing in the middle. */
export const MARK_LOOPS = {
  left: "M128 128C112 104 98 88 80 88C58 88 40 106 40 128C40 150 58 168 80 168C98 168 112 152 128 128",
  right: "M128 128C144 104 158 88 176 88C198 88 216 106 216 128C216 150 198 168 176 168C158 168 144 152 128 128",
} as const;

/** The glyph on a 256 × 256 canvas. `ink` and `accent` take any CSS colour (or var()); `withFrame` adds the outline of the case. */
export function markGlyph(ink = INK, accent = ACCENT, withFrame = false): string {
  return [
    withFrame ? `<rect x="20" y="36" width="216" height="184" rx="38" fill="none" stroke="${ink}" stroke-opacity=".3" stroke-width="7"/>` : "",
    `<path d="${MARK_LOOPS.left}" fill="none" stroke="${ink}" stroke-opacity=".92" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="${MARK_LOOPS.right}" fill="none" stroke="${accent}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`,
  ].join("");
}

export function markSvg(options: { ink?: string; accent?: string; frame?: boolean; label?: string; className?: string; tight?: boolean } = {}): string {
  const label = options.label ? ` role="img" aria-label="${options.label}"` : ' aria-hidden="true"';
  // `tight` crops the canvas to the lemniscate (a wide, low box) for the header; otherwise it is the square canvas.
  const box = options.tight ? "28 72 200 112" : "0 0 256 256";
  return `<svg viewBox="${box}"${label}${options.className ? ` class="${options.className}"` : ""}>${markGlyph(options.ink, options.accent, options.frame ?? false)}</svg>`;
}

/** Printed on the label of the extracted cassette (an image, so no CSS variables). */
export const labelMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${markGlyph("#171713", "#b27a22", false)}</svg>`;

/** Mark + wordmark, used by the splash screen. */
export const logo = (className = "") =>
  `<div class="logo ${className}"><span class="logo-mark">${markSvg({ label: "Vitrine" })}</span><span class="logo-word"><b>VITRINE</b><i>琉匣</i></span></div>`;

export const brandHeading = `<h1>VITRINE</h1><div>琉匣 · MINECRAFT LAUNCHER</div>`;

export const PRODUCT = { name: "Vitrine", nameCn: "琉匣", tagline: "玻璃柜里的 Minecraft 启动器" } as const;
