/**
 * The colours of a cover: what the page behind the record is tinted with. Pure arithmetic on pixels (`rgba`, four bytes
 * each) so that it is tested without a canvas.
 */

export type Rgb = [number, number, number];

export interface CoverColours {
  /** The most vivid colour of the cover, a second and a third one that differ from it in hue, and the average. */
  vivid: Rgb;
  second: Rgb;
  third: Rgb;
  average: Rgb;
}

/** Used when there is no cover: black-gold and two quiet companions. */
export const FALLBACK_COLOURS: CoverColours = { vivid: [178, 122, 34], second: [232, 185, 103], third: [132, 110, 76], average: [140, 128, 105] };

const BUCKETS = 12;

function toHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

/** The mean colour of the pixels that are not (nearly) transparent. */
export function averageColour(rgba: ArrayLike<number>): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 24) continue;
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    n++;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : FALLBACK_COLOURS.average;
}

/**
 * Pick the colours of a cover. Pixels are sorted into hue buckets and weighted by how saturated and bright they are, so that
 * a grey border or a white background does not win over the picture; the best bucket gives the vivid colour, and the best
 * buckets at least two steps of hue away from the ones already taken give the other two.
 */
export function pickColours(rgba: ArrayLike<number>): CoverColours {
  const weight = new Float64Array(BUCKETS);
  const sum = Array.from({ length: BUCKETS }, () => [0, 0, 0, 0]);
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 24) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const [h, s, v] = toHsv(r, g, b);
    const w = s * s * (0.25 + v) + 0.002;
    const bucket = Math.min(BUCKETS - 1, Math.floor((h / 360) * BUCKETS));
    weight[bucket] += w;
    const acc = sum[bucket];
    acc[0] += r * w;
    acc[1] += g * w;
    acc[2] += b * w;
    acc[3] += w;
  }
  const taken: number[] = [];
  const out: Rgb[] = [];
  for (let pick = 0; pick < 3; pick++) {
    let best = -1;
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      if (weight[bucket] <= 0.01) continue;
      const near = taken.some((other) => {
        const gap = Math.abs(bucket - other);
        return Math.min(gap, BUCKETS - gap) < 2;
      });
      if (near) continue;
      if (best < 0 || weight[bucket] > weight[best]) best = bucket;
    }
    if (best < 0) break;
    taken.push(best);
    const acc = sum[best];
    out.push([Math.round(acc[0] / acc[3]), Math.round(acc[1] / acc[3]), Math.round(acc[2] / acc[3])]);
  }
  if (!out.length) return { ...FALLBACK_COLOURS, average: averageColour(rgba) };
  const average = averageColour(rgba);
  return { vivid: out[0], second: out[1] ?? shift(out[0], 0.5), third: out[2] ?? shift(out[0], -0.5), average };
}

/** A colour moved towards another hue-ish by mixing with its own channel rotation (a stand-in when the cover has one colour only). */
function shift(colour: Rgb, amount: number): Rgb {
  const [r, g, b] = colour;
  const t = Math.abs(amount);
  const rotated: Rgb = amount > 0 ? [b, r, g] : [g, b, r];
  return [Math.round(r + (rotated[0] - r) * t), Math.round(g + (rotated[1] - g) * t), Math.round(b + (rotated[2] - b) * t)];
}

/** `colour` pulled towards `base` by `amount` (0 = the colour, 1 = the base). */
export function mixRgb(colour: Rgb, base: Rgb, amount: number): Rgb {
  return [Math.round(colour[0] + (base[0] - colour[0]) * amount), Math.round(colour[1] + (base[1] - colour[1]) * amount), Math.round(colour[2] + (base[2] - colour[2]) * amount)];
}
