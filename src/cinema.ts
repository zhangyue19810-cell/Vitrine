import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/**
 * The look of the film for deep space. Two passes run on the linear, high-range picture just before it is tone-mapped:
 *
 *  - bloom: what is brighter than paper white (the photon ring, the white-hot inner disk, the glints on the plates) bleeds into its
 *    surroundings the way light does in a lens;
 *  - the grade: a horizontal anamorphic streak off the brightest points, a little colour fringing towards the corners, a vignette
 *    and film grain. Each is a few percent of what a poster would use: it should be felt, not seen.
 *
 * Both are driven by one number, the share of the picture that is deep space (`film`, 0 … 1), and are switched off below a small
 * share and on the low quality tiers, so the home page and the download pages are not touched.
 */

export const CINEMA = {
  /** Bloom: strength at full film, how far it spreads, and the brightness (linear) from which things glow. */
  bloom: { strength: 0.62, radius: 0.55, threshold: 0.82 },
  /** Fringing at the corner of the picture (share of the width), and the vignette's strength. */
  fringe: 0.0075,
  vignette: 0.5,
  /** Grain amplitude (linear light) and the streak's strength; the streak is left out on the middle tiers. */
  grain: 0.012,
  streak: 0.075,
} as const;

const GRADE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GRADE_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uFilm;
uniform float uStreak;
uniform float uTime;
uniform float uAspect;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec2 c = vUv - 0.5;
  vec2 k = c * vec2(uAspect, 1.0);
  float r2 = dot(k, k);
  // Colour fringing: red and blue are looked up a little apart, more so towards the corners.
  vec2 off = c * r2 * ${CINEMA.fringe.toFixed(5)} * uFilm;
  vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);

  // The anamorphic streak: the bright part of the picture, smeared along the width with a long tail, in the warm of the disk.
  if (uStreak > 0.0) {
    vec3 sum = vec3(0.0);
    // Each pixel looks a little nearer or further than its neighbours: eight taps would otherwise leave a row of eight copies of a
    // small bright thing; this way they run into a line (the grain covers what is left).
    float jitter = hash(gl_FragCoord.xy * 0.713 + 17.0) - 0.5;
    for (int i = 1; i <= 8; i++) {
      float fi = float(i) + jitter * 0.9;
      float o = fi * fi * 0.0038;
      float w = exp(-fi * 0.38);
      vec3 a = texture2D(tDiffuse, vUv + vec2(o, 0.0)).rgb;
      vec3 b = texture2D(tDiffuse, vUv - vec2(o, 0.0)).rgb;
      sum += (max(a - 0.95, 0.0) + max(b - 0.95, 0.0)) * w;
    }
    col += sum * vec3(1.0, 0.8, 0.5) * ${CINEMA.streak.toFixed(5)} * uStreak * uFilm;
  }

  // The vignette darkens the corners; the grain moves every frame and shows most in the middle tones.
  col *= 1.0 - ${CINEMA.vignette.toFixed(3)} * uFilm * smoothstep(0.18, 0.95, r2 * 1.6);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float noise = hash(gl_FragCoord.xy + fract(uTime * 7.31) * 311.7) + hash(gl_FragCoord.yx * 1.37 + fract(uTime * 3.17) * 97.3) - 1.0;
  col += noise * ${CINEMA.grain.toFixed(4)} * uFilm * (0.12 + 2.2 * clamp(lum, 0.0, 1.0));
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

/** Bloom and the grade, as two passes to be put in the composer after the antialiasing and before the output. */
export class Cinema {
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  private streak = 0;

  constructor(width: number, height: number) {
    this.bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(2, width), Math.max(2, height)), 0, CINEMA.bloom.radius, CINEMA.bloom.threshold);
    this.grade = new ShaderPass({
      name: "CinemaGrade",
      uniforms: {
        tDiffuse: { value: null },
        uFilm: { value: 0 },
        uStreak: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: width / Math.max(1, height) },
      },
      vertexShader: GRADE_VERTEX,
      fragmentShader: GRADE_FRAGMENT,
    });
    this.bloom.enabled = false;
    this.grade.enabled = false;
  }

  /** Whether the long streak is drawn (the higher quality tiers). */
  setStreak(on: boolean) {
    this.streak = on ? 1 : 0;
  }

  /** Set how much of the picture is deep space (`film`, 0 … 1) at `time` seconds, and the picture's aspect ratio. A tier without the film passes 0. */
  update(film: number, time: number, aspect: number) {
    film = Math.min(1, Math.max(0, film));
    const on = film > 0.02;
    this.bloom.enabled = on;
    this.grade.enabled = on;
    if (!on) return;
    this.bloom.strength = CINEMA.bloom.strength * film;
    this.bloom.radius = CINEMA.bloom.radius;
    this.bloom.threshold = CINEMA.bloom.threshold;
    const uniforms = this.grade.uniforms as Record<string, { value: number }>;
    uniforms.uFilm.value = film;
    uniforms.uStreak.value = this.streak;
    uniforms.uTime.value = time % 1000;
    uniforms.uAspect.value = aspect;
  }

  /** Whether any pass is drawing this frame. */
  get active(): boolean {
    return this.grade.enabled;
  }

  dispose() {
    this.bloom.dispose();
    this.grade.dispose();
  }
}
