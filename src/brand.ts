/**
 * Vitrine · 琉匣 — the mark is a "V" made of two overlapping panes of glass (one clear, one tinted) standing in a
 * display case; the small strip under it is the case's label, a nod to the cassettes of the shelf.
 */

const INK = "currentColor";
const ACCENT = "var(--accent, #2fb5a3)";

/** The glyph on a 256 × 256 canvas. `ink` and `accent` take any CSS colour (or var()). */
export function markGlyph(ink = INK, accent = ACCENT, withFrame = true): string {
  return [
    withFrame ? `<rect x="20" y="36" width="216" height="184" rx="38" fill="none" stroke="${ink}" stroke-opacity=".5" stroke-width="9"/>` : "",
    `<path d="M54 66H100L140 152 128 190Z" fill="${ink}"/>`,
    `<path d="M202 66H156L116 152 128 190Z" fill="${accent}" fill-opacity=".92"/>`,
    withFrame ? `<path d="M96 205H160" stroke="${ink}" stroke-opacity=".75" stroke-width="8" stroke-linecap="round"/>` : "",
  ].join("");
}

export function markSvg(options: { ink?: string; accent?: string; frame?: boolean; label?: string; className?: string } = {}): string {
  const label = options.label ? ` role="img" aria-label="${options.label}"` : ' aria-hidden="true"';
  return `<svg viewBox="0 0 256 256"${label}${options.className ? ` class="${options.className}"` : ""}>${markGlyph(options.ink, options.accent, options.frame ?? true)}</svg>`;
}

/** Printed on the label of the extracted cassette (an image, so no CSS variables). */
export const labelMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${markGlyph("#171713", "#1f9e8e", true)}</svg>`;

/** Mark + wordmark, used by the splash screen. */
export const logo = (className = "") =>
  `<div class="logo ${className}"><span class="logo-mark">${markSvg({ label: "Vitrine" })}</span><span class="logo-word"><b>VITRINE</b><i>琉匣</i></span></div>`;

export const brandHeading = `<h1>VITRINE</h1><div>琉匣 · MINECRAFT LAUNCHER</div>`;

export const PRODUCT = { name: "Vitrine", nameCn: "琉匣", tagline: "玻璃柜里的 Minecraft 启动器" } as const;
