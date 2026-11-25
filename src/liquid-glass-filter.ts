/**
 * Radial backdrop lens modelled on the supplied liquid-glass shader.
 *
 * The reference shader computes an inward offset near a circular glass rim
 * (`-dir * f * (d/r)^7`) and samples a lightly blurred render texture. Here
 * the vector field is baked once into a small PNG and fed to SVG
 * `feDisplacementMap`; the browser only performs a texture lookup + blur for
 * each panel, instead of animating `feTurbulence` over the live 3D scene.
 *
 * The vector-map part follows the technique shown in the author's
 * liquid-glass source; the filter is generated locally (no external asset).
 */

const SVG_NS = "http://www.w3.org/2000/svg";
export const GLASS_LENS_ID = "vitrine-glass-lens";

/** Bake an RGB displacement map: 128 is no offset, R/G encode ±x/±y. */
function makeLensMap(size = 256): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(size, size);
  const data = image.data;
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const distance = Math.hypot(dx, dy);
      const t = Math.min(1, distance / centre);
      // The supplied shader uses a seventh-power falloff, so the centre stays
      // clear and the distortion is concentrated in the last few pixels of
      // the glass wall.
      const bend = t ** 7;
      const nx = distance > 0.0001 ? -dx / distance : 0;
      const ny = distance > 0.0001 ? -dy / distance : 0;
      const at = (y * size + x) * 4;
      data[at] = 128 + nx * bend * 127;
      data[at + 1] = 128 + ny * bend * 127;
      data[at + 2] = 128;
      data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

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
  filter.setAttribute("x", "-12%");
  filter.setAttribute("y", "-12%");
  filter.setAttribute("width", "124%");
  filter.setAttribute("height", "124%");
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const map = document.createElementNS(SVG_NS, "feImage");
  map.setAttribute("href", makeLensMap());
  map.setAttribute("preserveAspectRatio", "none");
  map.setAttribute("result", "lens-map");

  const soft = document.createElementNS(SVG_NS, "feGaussianBlur");
  soft.setAttribute("in", "SourceGraphic");
  // The reference uses a ~2px blur; the CSS backdrop already supplies the
  // broader frost, so this only smooths the displaced sample.
  soft.setAttribute("stdDeviation", "1.1");
  soft.setAttribute("result", "soft-backdrop");

  const displacement = document.createElementNS(SVG_NS, "feDisplacementMap");
  displacement.setAttribute("in", "soft-backdrop");
  displacement.setAttribute("in2", "lens-map");
  displacement.setAttribute("scale", "13");
  displacement.setAttribute("xChannelSelector", "R");
  displacement.setAttribute("yChannelSelector", "G");

  filter.append(map, soft, displacement);
  host.append(filter);
  document.body.prepend(host);
}
