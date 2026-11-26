/**
 * Radial lens backdrop based on the supplied liquid-glass shader.
 *
 * The shader pushes samples inward near a circular rim and blurs them. Here
 * that becomes a small SVG filter graph:
 *
 *   SourceGraphic ── blur ── displacement ── mask to rim ── over original
 *
 * The centre therefore keeps the unmodified backdrop (clear glass); only the
 * rim is blurred and pulled toward the centre. Two pre-baked PNG masks keep
 * the graph static and cheap: no turbulence is animated behind the live 3D
 * scene.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
export const GLASS_LENS_ID = "vitrine-glass-lens";

const smoothstep = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** RGB displacement map: 128 is no offset, R/G encode ±x/±y. */
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

/** Alpha mask: transparent in the middle, opaque toward the rim. */
function makeEdgeMask(size = 256): string {
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
      const t = Math.min(1, Math.hypot(dx, dy) / centre);
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(smoothstep(0.58, 0.96, t) * 255);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Install once, before the first glass surface paints. */
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
  filter.setAttribute("x", "-15%");
  filter.setAttribute("y", "-15%");
  filter.setAttribute("width", "130%");
  filter.setAttribute("height", "130%");
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const displacement = document.createElementNS(SVG_NS, "feImage");
  displacement.setAttribute("href", makeLensMap());
  displacement.setAttribute("preserveAspectRatio", "none");
  displacement.setAttribute("result", "lens-map");

  const edge = document.createElementNS(SVG_NS, "feImage");
  edge.setAttribute("href", makeEdgeMask());
  edge.setAttribute("preserveAspectRatio", "none");
  edge.setAttribute("result", "edge-mask");

  const soft = document.createElementNS(SVG_NS, "feGaussianBlur");
  soft.setAttribute("in", "SourceGraphic");
  soft.setAttribute("stdDeviation", "6");
  soft.setAttribute("result", "soft-backdrop");

  const bend = document.createElementNS(SVG_NS, "feDisplacementMap");
  bend.setAttribute("in", "soft-backdrop");
  bend.setAttribute("in2", "lens-map");
  bend.setAttribute("scale", "18");
  bend.setAttribute("xChannelSelector", "R");
  bend.setAttribute("yChannelSelector", "G");
  bend.setAttribute("result", "refracted");

  const rimOnly = document.createElementNS(SVG_NS, "feComposite");
  rimOnly.setAttribute("in", "refracted");
  rimOnly.setAttribute("in2", "edge-mask");
  rimOnly.setAttribute("operator", "in");
  rimOnly.setAttribute("result", "rim-glass");

  const over = document.createElementNS(SVG_NS, "feComposite");
  over.setAttribute("in", "rim-glass");
  over.setAttribute("in2", "SourceGraphic");
  over.setAttribute("operator", "over");

  filter.append(displacement, edge, soft, bend, rimOnly, over);
  host.append(filter);
  document.body.prepend(host);
}
