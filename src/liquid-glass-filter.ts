/**
 * Static SVG lens for the glass-card layer.
 *
 * The displacement part is adapted from the MIT-licensed `liquid-glass`
 * source supplied at `/storage/emulated/0/Vitrine/liquid-glass-main`
 * (© Dominik Pawlikowski). Vitrine already owns the motion and the DOM, so
 * only the procedural `feTurbulence` + `feDisplacementMap` lens is used here;
 * it stays static and the visual movement comes from the existing flowing
 * light layers and springs.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
export const GLASS_LENS_ID = "vitrine-glass-lens";

/** Install once, before the first surface paints. */
export function installGlassLens(): void {
  if (!document.body || document.getElementById(GLASS_LENS_ID)) return;

  const host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("focusable", "false");
  host.setAttribute("width", "0");
  host.setAttribute("height", "0");
  host.classList.add("glass-lens-root");

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", GLASS_LENS_ID);
  filter.setAttribute("x", "-20%");
  filter.setAttribute("y", "-20%");
  filter.setAttribute("width", "140%");
  filter.setAttribute("height", "140%");
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const turbulence = document.createElementNS(SVG_NS, "feTurbulence");
  turbulence.setAttribute("type", "fractalNoise");
  turbulence.setAttribute("baseFrequency", "0.006");
  turbulence.setAttribute("numOctaves", "2");
  turbulence.setAttribute("seed", "7");
  turbulence.setAttribute("result", "noise");

  const displacement = document.createElementNS(SVG_NS, "feDisplacementMap");
  displacement.setAttribute("in", "SourceGraphic");
  displacement.setAttribute("in2", "noise");
  displacement.setAttribute("scale", "9");
  displacement.setAttribute("xChannelSelector", "R");
  displacement.setAttribute("yChannelSelector", "G");

  filter.append(turbulence, displacement);
  host.append(filter);
  document.body.prepend(host);
}
