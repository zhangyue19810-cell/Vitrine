/**
 * Liquid Glass SVG renderer for Vitrine.
 *
 * The displacement/specular maps and filter graph are adapted from the MIT
 * licensed Liquid Glass implementation by Archis Vaze
 * (https://github.com/archisvaze/liquid-glass). Each UI surface family gets a
 * pre-baked convex-squircle refraction map; the browser composites the real
 * backdrop through the generated feDisplacementMap/filter chain.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const SAMPLES = 128;

const GLASS_DEFAULTS = {
  thickness: 81,
  bezel: 50,
  ior: 1.98,
  scaleRatio: 2.0,
  blur: 0,
  specularOpacity: 0.18,
  specularSaturation: 4,
} as const;

export type GlassShape = "panel" | "card" | "control" | "pill" | "chip" | "round" | "field";

export const GLASS_FILTER_IDS: Record<GlassShape, string> = {
  panel: "vitrine-liquid-glass-panel",
  card: "vitrine-liquid-glass-card",
  control: "vitrine-liquid-glass-control",
  pill: "vitrine-liquid-glass-pill",
  chip: "vitrine-liquid-glass-chip",
  round: "vitrine-liquid-glass-round",
  field: "vitrine-liquid-glass-field",
};

export const glassFilterUrl = (shape: GlassShape) => `url(#${GLASS_FILTER_IDS[shape]})`;

const SURFACE_FUNCTIONS = {
  convex_squircle: (x: number) => Math.pow(1 - Math.pow(1 - x, 4), 0.25),
};

interface Family {
  shape: GlassShape;
  width: number;
  height: number;
  radius: number;
}

const FAMILIES: Family[] = [
  { shape: "panel", width: 600, height: 360, radius: 46 },
  { shape: "card", width: 360, height: 220, radius: 26 },
  { shape: "control", width: 140, height: 52, radius: 22 },
  { shape: "pill", width: 220, height: 56, radius: 28 },
  { shape: "chip", width: 110, height: 32, radius: 16 },
  { shape: "round", width: 64, height: 64, radius: 32 },
  { shape: "field", width: 320, height: 48, radius: 22 },
];

function calculateRefractionProfile(thickness: number, bezel: number, heightFn: (x: number) => number, ior: number): Float64Array {
  const profile = new Float64Array(SAMPLES);
  const eta = 1 / ior;
  const refract = (nx: number, ny: number): [number, number] | null => {
    const k = 1 - eta * eta * (1 - ny * ny);
    if (k < 0) return null;
    const sq = Math.sqrt(k);
    return [-(eta * ny + sq) * nx, eta - (eta * ny + sq) * ny];
  };
  for (let i = 0; i < SAMPLES; i++) {
    const x = i / SAMPLES;
    const y = heightFn(x);
    const dx = x < 1 ? 0.0001 : -0.0001;
    const y2 = heightFn(x + dx);
    const derivative = (y2 - y) / dx;
    const magnitude = Math.sqrt(derivative * derivative + 1);
    const refracted = refract(-derivative / magnitude, -1 / magnitude);
    profile[i] = refracted ? refracted[0] * ((y * bezel + thickness) / refracted[1]) : 0;
  }
  return profile;
}

function generateDisplacementMap(width: number, height: number, radius: number, bezel: number, profile: Float64Array, maxDisp: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  const radiusSq = radius * radius;
  const radius1Sq = (radius + 1) ** 2;
  const innerSq = Math.max(radius - bezel, 0) ** 2;
  const widthBody = width - radius * 2;
  const heightBody = height - radius * 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x < radius ? x - radius : x >= width - radius ? x - radius - widthBody : 0;
      const dy = y < radius ? y - radius : y >= height - radius ? y - radius - heightBody : 0;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radius1Sq || distanceSq < innerSq) continue;
      const distance = Math.sqrt(distanceSq);
      const fromSide = radius - distance;
      const opacity = distanceSq < radiusSq ? 1 : 1 - (distance - Math.sqrt(radiusSq)) / (Math.sqrt(radius1Sq) - Math.sqrt(radiusSq));
      if (opacity <= 0 || distance === 0) continue;
      const cos = dx / distance;
      const sin = dy / distance;
      const profileIndex = Math.min(((fromSide / bezel) * profile.length) | 0, profile.length - 1);
      const displacement = profile[profileIndex] || 0;
      const offsetX = (-cos * displacement) / maxDisp;
      const offsetY = (-sin * displacement) / maxDisp;
      const index = (y * width + x) * 4;
      data[index] = (128 + offsetX * 127 * opacity + 0.5) | 0;
      data[index + 1] = (128 + offsetY * 127 * opacity + 0.5) | 0;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

function generateSpecularMap(width: number, height: number, radius: number, bezel: number, angle = Math.PI / 3): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const radiusSq = radius * radius;
  const radius1Sq = (radius + 1) ** 2;
  const innerSq = Math.max(radius - bezel, 0) ** 2;
  const widthBody = width - radius * 2;
  const heightBody = height - radius * 2;
  const light = [Math.cos(angle), Math.sin(angle)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x < radius ? x - radius : x >= width - radius ? x - radius - widthBody : 0;
      const dy = y < radius ? y - radius : y >= height - radius ? y - radius - heightBody : 0;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radius1Sq || distanceSq < innerSq) continue;
      const distance = Math.sqrt(distanceSq);
      const fromSide = radius - distance;
      const opacity = distanceSq < radiusSq ? 1 : 1 - (distance - Math.sqrt(radiusSq)) / (Math.sqrt(radius1Sq) - Math.sqrt(radiusSq));
      if (opacity <= 0 || distance === 0) continue;
      const cos = dx / distance;
      const sin = -dy / distance;
      const dot = Math.abs(cos * light[0] + sin * light[1]);
      const edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) ** 2));
      const coefficient = dot * edge;
      const colour = (255 * coefficient) | 0;
      const alpha = (colour * coefficient * opacity) | 0;
      const index = (y * width + x) * 4;
      data[index] = colour;
      data[index + 1] = colour;
      data[index + 2] = colour;
      data[index + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

function buildFilter(family: Family): string {
  const id = GLASS_FILTER_IDS[family.shape];
  const radius = Math.floor(Math.min(family.radius, family.width / 2, family.height / 2));
  const bezel = Math.max(1, Math.min(GLASS_DEFAULTS.bezel, radius - 1, Math.min(family.width, family.height) / 2 - 1));
  const profile = calculateRefractionProfile(GLASS_DEFAULTS.thickness, bezel, SURFACE_FUNCTIONS.convex_squircle, GLASS_DEFAULTS.ior);
  const maxDisp = Math.max(...Array.from(profile).map(Math.abs)) || 1;
  const displacement = generateDisplacementMap(family.width, family.height, radius, bezel, profile, maxDisp);
  const specular = generateSpecularMap(family.width, family.height, radius, bezel * 2.5);
  const scale = maxDisp * GLASS_DEFAULTS.scaleRatio;
  return `<filter id="${id}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${GLASS_DEFAULTS.blur}" result="blurred_source" />
      <feImage href="${displacement}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="disp_map" />
      <feDisplacementMap in="blurred_source" in2="disp_map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced" />
      <feColorMatrix in="displaced" type="saturate" values="${GLASS_DEFAULTS.specularSaturation}" result="displaced_sat" />
      <feImage href="${specular}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="spec_layer" />
      <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked" />
      <feComponentTransfer in="spec_layer" result="spec_faded">
        <feFuncA type="linear" slope="${GLASS_DEFAULTS.specularOpacity}" />
      </feComponentTransfer>
      <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat" />
      <feBlend in="spec_faded" in2="with_sat" mode="normal" />
    </filter>`;
}

/** Install the shared SVG filter definitions before the first surface paints. */
export function installGlassLens(): void {
  if (!document.body || document.querySelector(".liquid-glass-defs")) return;
  const host = document.createElementNS(SVG_NS, "svg");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("focusable", "false");
  host.setAttribute("width", "0");
  host.setAttribute("height", "0");
  host.setAttribute("class", "liquid-glass-defs");
  host.setAttribute("color-interpolation-filters", "sRGB");
  Object.assign((host as unknown as HTMLElement).style, { position: "absolute", overflow: "hidden", pointerEvents: "none" });
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML = FAMILIES.map(buildFilter).join("");
  host.append(defs);
  document.body.prepend(host);

  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;width:8px;height:8px;pointer-events:none;backdrop-filter:url(#vitrine-liquid-glass-control);-webkit-backdrop-filter:url(#vitrine-liquid-glass-control)";
  document.body.append(probe);
  const computed = getComputedStyle(probe).backdropFilter;
  probe.remove();
  const gecko = /Firefox\//.test(navigator.userAgent);
  document.documentElement.dataset.glassRenderer = !gecko && computed && computed !== "none" && computed.includes("url") ? "svg" : "fallback";
  document.documentElement.dataset.glassParams = "thickness=81;bezel=50;ior=1.98;scale=2;blur=0;specular=0.18;saturation=4;tint=0;inner=20/-5;outer=24;radius=46";
}
