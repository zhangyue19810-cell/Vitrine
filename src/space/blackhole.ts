import * as THREE from "three";
import { DISK, type System } from "./disk";
import { SHADOW, TABLE, TableBuilder } from "./geodesic";
import { RIPPLE, RIPPLE_GLSL, type RippleSet } from "./ripples";
import type { Eye } from "./cosmos";

/**
 * The black hole of the music world and the light of its accretion disk, drawn by one shader on a quad that faces the viewer.
 *
 * Every pixel of the quad is a ray of light that reaches the camera from the direction of the hole. The ray's impact parameter is
 * the pixel's distance from the middle; the table of `geodesic.ts` says where along its bent path (1/r at each angle swept) it
 * is, so the points where it crosses the plane of the disk are a few lookups away: the first crossing is the disk seen
 * directly, the second the far side of the disk seen over the top and under the bottom of the hole (the bright ring that
 * hugs the shadow), the third and fourth the thin rings inside that. At each crossing the disk glows with its own light:
 * brighter and bluer where it comes towards us (the Doppler factor of its orbit), hotter near the hole, in long streaks that
 * shear as the inner part turns quicker than the outer (Kepler's law) and sparse bright specks. A ray that falls in is black.
 *
 * The quad is drawn before the plates and the cards, with no depth, so they stand over it; the plates that would be behind the
 * hole are hidden by `disk.ts`. Premultiplied blending lets the disk add its light to the stars behind it and the shadow cover
 * them. The shader is cheap (a few texture reads and noise per pixel) because the physics is in the table.
 */

const MAX = RIPPLE.max;

const VERTEX = /* glsl */ `
uniform float uExtent;
varying vec2 vXY;
void main() {
  vXY = position.xy * uExtent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const f = (value: number) => value.toFixed(5);

const FRAGMENT = /* glsl */ `
uniform sampler2D uTable;
uniform vec2 uTableSize;
uniform float uTime;
uniform float uMix;
uniform float uSinE;
uniform float uCosE;
uniform float uRsWorld;
uniform float uLevel;
uniform float uDetail;
uniform float uSpin;
uniform float uExposure;
// The two phases of the turning disk and the weight of the second (see \`flowOf\`).
uniform vec3 uFlow;
// The picture's turn of the quad (cos, sin of the roll), how much the pointer is on the shadow and on the track, the share of the song played (< 0: none), and 1 while it plays.
uniform vec2 uRoll;
uniform vec2 uHover;
uniform vec2 uSong;
uniform vec3 uHot;
uniform vec3 uWarm;
uniform vec3 uCool;
uniform vec4 uRipple[${MAX}];
varying vec2 vXY;

${RIPPLE_GLSL}

const float PI = 3.14159265;
const float TAU = 6.2831853;
const float B_MAX = ${f(TABLE.bMax)};
const float B_POW = ${f(TABLE.power)};
const float PHI_MAX = ${f(TABLE.phiMax)};
const float R_IN = ${f(DISK.inner)};
const float R_OUT = ${f(DISK.outer)};
const float SHADOW = ${f(SHADOW)};

// u = 1/r and du/dphi of the ray with impact parameter b, after it has swept the angle phi round the hole.
vec2 lookup(float b, float phi) {
  float t = pow(min(b / B_MAX, 1.0), 1.0 / B_POW);
  vec2 uv = vec2((t * (uTableSize.x - 1.0) + 0.5) / uTableSize.x, (clamp(phi / PHI_MAX, 0.0, 1.0) * (uTableSize.y - 1.0) + 0.5) / uTableSize.y);
  return texture2D(uTable, uv).rg;
}

float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// Value noise that repeats every \`period\` cells along x (so that it closes round the disk).
float n2p(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  fr = fr * fr * (3.0 - 2.0 * fr);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  return mix(mix(h21(vec2(x0, i.y)), h21(vec2(x1, i.y)), fr.x), mix(h21(vec2(x0, i.y + 1.0)), h21(vec2(x1, i.y + 1.0)), fr.x), fr.y);
}

// The colour of the disk at a temperature: umber, amber, gold, then white.
vec3 ramp(float T) {
  vec3 c = mix(uCool, uWarm, smoothstep(0.1, 0.55, T));
  c = mix(c, uHot, smoothstep(0.45, 1.0, T));
  return mix(c, vec3(1.35, 1.25, 1.08), smoothstep(0.95, 1.8, T));
}

struct Hit {
  float u;
  float r;
  vec2 q;
  float dop;
  float fwR;
  float fwQ;
};

// Where the ray is when it has swept phi: its radius, its place in the plane of the disk (x to the right, y away from the
// viewer), how fast the disk moves towards us there, and how big a pixel is. Derivatives are read here, outside any branch.
Hit hitAt(float b, vec2 rho, float phi) {
  Hit h;
  vec2 ud = lookup(b, phi);
  h.u = ud.x;
  float r = 1.0 / max(ud.x, 0.001);
  float sp = sin(phi);
  float cp = cos(phi);
  vec3 e = vec3(sp * rho.x, sp * rho.y, cp);
  vec3 ephi = vec3(cp * rho.x, cp * rho.y, -sp);
  vec3 pos = r * e;
  h.q = vec2(pos.x, pos.y * uSinE - pos.z * uCosE);
  // The light's direction at the disk (towards the viewer) and the disk's own (counter-clockwise about its axis).
  vec3 k = ud.y * e - ud.x * ephi;
  k /= max(length(k), 1e-5);
  vec3 v = cross(vec3(0.0, uCosE, uSinE), e);
  float beta = sqrt(0.5 / max(r, 1.0));
  h.dop = 1.0 / (inversesqrt(1.0 - beta * beta) * (1.0 - beta * dot(v, k)));
  h.r = r;
  h.fwR = fwidth(r);
  h.fwQ = max(fwidth(h.q.x), fwidth(h.q.y));
  return h;
}

// The grain of the disk when its pattern has been turning for \`t\` seconds: (streaks, specks), each 0 … 1. The streaks are long
// in the direction of the orbit (a few cells round the whole turn, many across), in three scales; the finer ones fade out where
// a pixel is too coarse to show them (\`fq\`: a pixel in turns, \`fwR\`: a pixel in horizon radii).
vec2 grain(float angle, float rr, float t, float fq, float fwR) {
  float turns = (angle - uSpin * pow(R_IN / rr, 1.5) * t) / TAU;
  float g1 = n2p(vec2(turns * 14.0, rr * 3.0), 14.0);
  float g2 = n2p(vec2(turns * 56.0 + 7.3, rr * 9.0), 56.0);
  float g3 = n2p(vec2(turns * 190.0 + 3.1, rr * 24.0), 190.0);
  float v2 = (1.0 - smoothstep(0.3, 0.9, max(fq * 56.0, fwR * 9.0))) * step(0.2, uDetail);
  float v3 = (1.0 - smoothstep(0.3, 0.9, max(fq * 190.0, fwR * 24.0))) * step(0.55, uDetail);
  float streak = 0.5 * g1 + 0.32 * mix(0.5, g2, v2) + 0.2 * mix(0.5, g3, v3);
  streak = smoothstep(0.14, 0.86, streak);
  // Sparse bright specks, a little longer along the orbit than across it.
  float v4 = (1.0 - smoothstep(0.3, 0.9, max(fq * 320.0, fwR * 16.0))) * step(0.35, uDetail);
  float spark = smoothstep(0.86, 1.0, n2p(vec2(turns * 320.0 + 11.0, rr * 16.0), 320.0)) * v4;
  return vec2(streak, spark);
}

// The light of the disk at a crossing: premultiplied colour and its opacity.
vec4 diskAt(Hit h) {
  float r = h.r;
  vec2 q = h.q;
  // The water: crests of the rings dropped in this plane lift the light and bend the streaks.
  float crest = 0.0;
  float bend = 0.0;
  for (int i = 0; i < ${MAX}; i++) {
    float age = uRipple[i].z;
    if (age < 0.0) continue;
    float d = length(q - uRipple[i].xy) * uRsWorld;
    float w = ringWave(d, age) * uRipple[i].w / (1.0 + d * 0.03);
    crest += max(w, 0.0);
    bend += w;
  }
  float rr = r + bend * 0.12;
  float angle = atan(q.y, q.x);
  float fq = h.fwQ / (TAU * r);

  float prof = pow(R_IN / rr, 1.7) * smoothstep(R_IN - 0.02, R_IN + 0.28, rr) * (1.0 - smoothstep(R_OUT - 6.0, R_OUT, rr));
  // The inner parts turn quicker than the outer, so any pattern is sheared into ever tighter spirals; two copies of the pattern,
  // started half a period apart, are crossfaded so that none is older than one period (most of the time only one is drawn).
  vec2 gr = vec2(0.0);
  if (uFlow.z < 0.999) gr += (1.0 - uFlow.z) * grain(angle, rr, uFlow.x, fq, h.fwR);
  if (uFlow.z > 0.001) gr += uFlow.z * grain(angle, rr, uFlow.y, fq, h.fwR);
  float streak = gr.x;
  float spark = gr.y;
  // A few dark lanes: gaps in the disk.
  float lanes = 1.0 - 0.55 * smoothstep(0.78, 0.98, n2p(vec2(rr * 1.7 + 3.0, 0.5), 9999.0));

  float D = clamp(h.dop, 0.35, 2.3);
  float light = prof * lanes * (0.26 + 1.55 * streak + 4.5 * spark) * pow(D, 2.4);
  light *= 1.0 + 2.4 * min(crest, 1.0) + 0.3 * uLevel * prof;
  float T = pow(R_IN / rr, 0.75) * (0.5 + 0.55 * D) * (1.0 + 0.5 * min(crest, 1.0));
  float alpha = clamp(prof * lanes * (0.3 + 1.2 * streak) * 1.15, 0.0, 0.96);
  return vec4(ramp(T) * light * alpha, alpha);
}

void layer(Hit h, inout vec3 col, inout float trans) {
  float falls = smoothstep(0.95, 0.99, h.u);
  float gone = 1.0 - smoothstep(0.0008, 0.002, h.u);
  float seen = (1.0 - falls) * (1.0 - gone);
  if (seen < 0.002 || h.r < R_IN - 0.5 || h.r > R_OUT + 0.5) return;
  vec4 e = diskAt(h);
  col += trans * seen * e.rgb;
  trans *= 1.0 - seen * e.a;
}

void main() {
  vec2 p = vXY;
  float b = length(p);
  if (b > B_MAX - 0.4) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 rho = p / max(b, 1e-4);
  // The ray's plane meets the disk's plane along a line: the angles at which it crosses are that line's angle plus whole turns of pi.
  float phi0 = atan(-uSinE, rho.y * uCosE);
  if (phi0 < 0.0) phi0 += PI;
  Hit h0 = hitAt(b, rho, phi0);
  Hit h1 = hitAt(b, rho, phi0 + PI);
  Hit h2 = hitAt(b, rho, phi0 + 2.0 * PI);
  Hit h3 = hitAt(b, rho, phi0 + 3.0 * PI);
  float uEnd = lookup(b, PHI_MAX - 0.02).x;

  vec3 col = vec3(0.0);
  float trans = 1.0;
  layer(h0, col, trans);
  layer(h1, col, trans);
  layer(h2, col, trans);
  layer(h3, col, trans);
  // A ray that ends in the hole is black behind whatever of the disk it passed first.
  trans *= 1.0 - smoothstep(0.96, 0.995, uEnd);

  // The photon ring: the thin bright edge of the shadow, and a soft glow round it, brighter on the side that comes towards us.
  float ring = exp(-pow((b - SHADOW * 1.012) / 0.05, 2.0));
  float halo = exp(-pow((b - SHADOW * 1.04) / 0.9, 2.0));
  vec3 glow = uHot * (ring * 0.85 + halo * 0.13) * (0.72 - 0.3 * rho.x) * (1.0 + 0.6 * uLevel);

  // The song, drawn into the picture: a thin track round the shadow, the played part of it bright, with a head where the song is; and,
  // while the pointer rests on the shadow, the symbol of what a click does. Both are measured on the picture, not on the disk.
  vec2 s = vec2(p.x * uRoll.x - p.y * uRoll.y, p.x * uRoll.y + p.y * uRoll.x);
  vec3 hud = vec3(0.0);
  float turn = atan(s.x, s.y) / TAU;
  turn += step(turn, 0.0);
  float track = exp(-pow((b - SHADOW * 1.24) / (0.03 + 0.03 * uHover.y), 2.0));
  float played = uSong.x >= 0.0 ? 1.0 - smoothstep(uSong.x - 0.003, uSong.x + 0.003, turn) : 0.0;
  float gap = abs(turn - uSong.x);
  gap = min(gap, 1.0 - gap) * TAU * SHADOW * 1.24;
  float head = uSong.x >= 0.0 ? exp(-pow(gap / (0.1 + 0.05 * uHover.y), 2.0)) * smoothstep(0.1, 0.3, b - SHADOW) : 0.0;
  float live = uSong.x >= 0.0 ? 1.0 : 0.0;
  hud += uHot * track * live * (0.1 + 0.2 * uHover.y + 0.95 * played) * (0.85 + 0.3 * uLevel);
  hud += vec3(1.3, 1.1, 0.8) * head * track * (1.6 + 1.2 * uHover.y);
  // ▶ when paused, ❚❚ when playing.
  vec2 g = s / (SHADOW * 0.34);
  float bars = min(max(abs(abs(g.x) - 0.36) - 0.14, abs(g.y) - 0.52), 9.0);
  float tri = max(-0.32 - g.x, max(((g.x + 0.32) * 0.5 + (g.y - 0.5) * 0.82) / 0.96, ((g.x + 0.32) * 0.5 + (-g.y - 0.5) * 0.82) / 0.96));
  float shape = mix(tri, bars, uSong.y);
  float glyph = (1.0 - smoothstep(-0.02, 0.06, shape)) * uHover.x * smoothstep(SHADOW * 0.92, SHADOW * 0.72, b);
  hud += vec3(1.25, 0.98, 0.62) * glyph * 0.8;

  // A soft shoulder: what is far brighter than paper white is held back, so the bloom does not turn the whole bright side to white.
  vec3 lit = (col + glow) * uExposure;
  lit = lit / (1.0 + 0.28 * lit);
  gl_FragColor = vec4(lit + hud, 1.0 - trans) * uMix;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface BlackHoleFrame {
  /** 0 … 1: how much of the world is shown. */
  mix: number;
  time: number;
  system: System | null;
  eye: Eye | null;
  ripples: RippleSet;
  /** How much the pointer is on the shadow and on the track round it (0 … 1 each). */
  hover?: { shadow: number; track: number };
  /** The share of the song played (0 … 1), or null when nothing is loaded; and how much it is playing (0 … 1). */
  song?: { progress: number | null; playing: number };
  /** 0 … 1: how loud the bass is (the ring swells with it). */
  level: number;
  /** Seconds since the last frame. */
  dt: number;
}

const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/** How long (seconds) one copy of the disk's pattern lives before the other takes over. */
export const FLOW_PERIOD = 40;

/**
 * The two phases of the pattern and the weight of the second, at `time`: phase one is `time` modulo the period, phase two the
 * same half a period later. The pattern jumps back to its start at its own reset, which is hidden by the other one being all that is
 * seen then (the weight is 1 round the first's reset, 0 round the second's), and the two are crossfaded in between.
 */
export function flowOf(time: number, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
  const t = ((time % FLOW_PERIOD) + FLOW_PERIOD) % FLOW_PERIOD;
  const fraction = t / FLOW_PERIOD;
  out.x = t;
  out.y = (t + FLOW_PERIOD / 2) % FLOW_PERIOD;
  out.z = fraction < 0.5 ? 1 - smooth((fraction - 0.05) / 0.15) : smooth((fraction - 0.8) / 0.15);
  return out;
}

/** The default light of the disk (linear colours): umber, amber and gold. */
const PALETTE = { cool: [0.32, 0.095, 0.022], warm: [1.0, 0.5, 0.115], hot: [1.3, 0.92, 0.43] } as const;

export class BlackHole {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly builder: TableBuilder | null;
  private texture: THREE.DataTexture;
  private ready = false;
  private readonly basis = new THREE.Matrix4();
  private readonly right = new THREE.Vector3();
  private readonly over = new THREE.Vector3();
  private readonly toward = new THREE.Vector3();
  private level = 0;
  private detail = 1;

  /** `prebuilt` is for tests and tools that already have the table. */
  constructor(builder: TableBuilder | null = new TableBuilder()) {
    this.builder = builder;
    // Until the table is traced the hole is not drawn; a 1 × 1 texture keeps the shader valid.
    this.texture = new THREE.DataTexture(new Uint16Array(2), 1, 1, THREE.RGFormat, THREE.HalfFloatType);
    this.texture.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      // Drawn with the opaque things (before the plates and the cards), over the sky, with premultiplied blending.
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uTable: { value: this.texture },
        uTableSize: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uMix: { value: 0 },
        uSinE: { value: Math.sin(DISK.elevation) },
        uCosE: { value: Math.cos(DISK.elevation) },
        uRsWorld: { value: 1 },
        uExtent: { value: 20 },
        uLevel: { value: 0 },
        uDetail: { value: 1 },
        uSpin: { value: DISK.spin },
        uFlow: { value: new THREE.Vector3(0, 0, 0) },
        uRoll: { value: new THREE.Vector2(1, 0) },
        uHover: { value: new THREE.Vector2(0, 0) },
        uSong: { value: new THREE.Vector2(-1, 0) },
        uExposure: { value: 0.62 },
        uHot: { value: new THREE.Vector3(...PALETTE.hot) },
        uWarm: { value: new THREE.Vector3(...PALETTE.warm) },
        uCool: { value: new THREE.Vector3(...PALETTE.cool) },
        uRipple: { value: Array.from({ length: MAX }, () => new THREE.Vector4(0, 0, -1, 0)) },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1), this.material);
    this.mesh.name = "black-hole";
    this.mesh.frustumCulled = false;
    // After the nebula and the stars of the sky (−300, −200), before everything solid.
    this.mesh.renderOrder = -100;
    this.mesh.userData.excludeFromAO = true;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  /** True once the table of rays is traced and the hole can be drawn. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Trace some of the table (a few milliseconds a frame, until it is done). Cheap once it is. */
  warm(budget = 4): boolean {
    if (this.ready) return true;
    if (!this.builder) return false;
    if (!this.builder.step(budget)) return false;
    const { width, height, half } = this.builder.table;
    this.texture.dispose();
    this.texture = new THREE.DataTexture(half, width, height, THREE.RGFormat, THREE.HalfFloatType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.material.uniforms.uTable.value = this.texture;
    (this.material.uniforms.uTableSize.value as THREE.Vector2).set(width, height);
    this.ready = true;
    return true;
  }

  /** 0 … 1: how much of the disk's fine detail to draw (the quality tier turns it down). */
  setDetail(detail: number) {
    this.detail = THREE.MathUtils.clamp(detail, 0, 1);
  }

  /** The light of the disk (any CSS colours): hot (inner edge), warm and cool (outer); null goes back to the default gold. */
  setPalette(colours: { hot: THREE.ColorRepresentation; warm: THREE.ColorRepresentation; cool: THREE.ColorRepresentation } | null) {
    const set = (uniform: string, value: THREE.ColorRepresentation | undefined, fallback: readonly number[]) => {
      const target = this.material.uniforms[uniform].value as THREE.Vector3;
      if (value === undefined) target.set(fallback[0], fallback[1], fallback[2]);
      else {
        const colour = new THREE.Color(value);
        target.set(colour.r, colour.g, colour.b);
      }
    };
    set("uHot", colours?.hot, PALETTE.hot);
    set("uWarm", colours?.warm, PALETTE.warm);
    set("uCool", colours?.cool, PALETTE.cool);
  }

  update(frame: BlackHoleFrame) {
    const { mix, time, system, ripples, eye, dt } = frame;
    const shown = system !== null && eye !== null && mix > 0.002 && this.ready;
    this.mesh.visible = shown;
    if (!shown || !system || !eye) return;

    this.level += (frame.level - this.level) * (1 - Math.exp(-(frame.level > this.level ? 18 : 5) * Math.min(0.25, Math.max(0, dt))));
    // The hole grows into its place as the world opens.
    const rs = system.rs * (0.6 + 0.4 * smooth(mix));
    // The quad covers the whole picture, whatever the turn of the disk.
    const extent = 1.3 * Math.hypot(eye.halfWidth, eye.halfHeight) + 2 * system.radius;
    this.right.fromArray(system.right);
    this.over.fromArray(system.over);
    this.toward.fromArray(system.toward);
    this.basis.makeBasis(this.right, this.over, this.toward);
    this.mesh.position.fromArray(system.centre);
    this.mesh.quaternion.setFromRotationMatrix(this.basis);
    this.mesh.scale.set(extent, extent, 1);

    const u = this.material.uniforms;
    u.uExtent.value = extent / rs;
    u.uRsWorld.value = rs;
    u.uTime.value = time % 3600;
    u.uSinE.value = Math.sin(system.elevation);
    u.uCosE.value = Math.cos(system.elevation);
    (u.uRoll.value as THREE.Vector2).set(Math.cos(system.roll), Math.sin(system.roll));
    (u.uHover.value as THREE.Vector2).set(frame.hover?.shadow ?? 0, frame.hover?.track ?? 0);
    const song = frame.song;
    (u.uSong.value as THREE.Vector2).set(song && song.progress !== null ? Math.min(1, Math.max(0, song.progress)) : -1, song?.playing ?? 0);
    flowOf(time, u.uFlow.value as THREE.Vector3);
    u.uMix.value = smooth(mix);
    u.uLevel.value = this.level;
    u.uDetail.value = this.detail;

    const slots = u.uRipple.value as THREE.Vector4[];
    for (let i = 0; i < MAX; i++) {
      const ripple = ripples.items[i];
      if (!ripple) {
        slots[i].set(0, 0, -1, 0);
        continue;
      }
      const dx = ripple.x - system.centre[0];
      const dy = ripple.y - system.centre[1];
      const dz = ripple.z - system.centre[2];
      const x = (dx * system.right[0] + dy * system.right[1] + dz * system.right[2]) / rs;
      const y = (dx * system.back[0] + dy * system.back[1] + dz * system.back[2]) / rs;
      slots[i].set(x, y, ripple.age, ripple.power);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.group.removeFromParent();
  }
}
