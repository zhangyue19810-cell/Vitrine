import * as THREE from "three";
import { damp, type Spring } from "../motion";
import type { SpectrumField } from "../spectrum";
import type { Eye } from "./cosmos";
import type { System } from "./disk";

/**
 * The lyrics of the music page, drawn in the scene itself: the line being sung stands large in the middle of the picture, in front
 * of the black hole, its letters bright and white until the singer reaches them and gold after; the lines before and after it
 * recede up and down the picture, smaller, dimmer and out of focus, leaning away like the surface of a drum. Every letter is its own
 * little quad that jumps with the band of the music that lies under it (the left of the line hears the bass, the right the treble),
 * swells with it and flashes as the line begins. Nothing here is HTML.
 *
 * How: each letter is drawn once into an atlas (red: the letter, green: its glow, blue: a dilated shadow that keeps it readable over
 * the bright disk); a line is one mesh of such quads whose motion is all in the vertex shader, driven by the 20 bands and a handful
 * of per-line numbers that the CPU moves with springs. One draw call per line, a few lines at a time.
 */

export interface LyricLine {
  /** Start in milliseconds. */
  t: number;
  text: string;
  trans?: string;
}

/** What the layer is told every frame about the song. */
export interface LyricsState {
  /** Changes with the song (the lines are laid out again). */
  id: number;
  /** The lines of the song with time stamps; null when there are none (the title is shown instead). */
  lines: readonly LyricLine[] | null;
  /** The line being sung (−1 before the first). */
  index: number;
  positionMs: number;
  /** What stands in the middle when there are no lines. */
  title: string;
  subtitle: string;
}

export interface LyricsFrame {
  state: LyricsState | null;
  system: System;
  eye: Eye;
  audio: SpectrumField | null;
  /** The bass of the music, 0 … 1. */
  bass: number;
  /** 0 … 1: how much of the picture is the music world. */
  mix: number;
  /** 0 … 1: how far the cards are out (the lyrics make room for them). */
  reveal: number;
  /** Reduced motion: the letters do not jump. */
  calm: boolean;
  dt: number;
  time: number;
}

export const LYRICS = {
  /** The size of the line being sung, as a share of half the picture's height (the height of one em). */
  em: 0.12,
  /** The width a line may take (a share of the picture's width), and how much smaller the whole block becomes while the cards are out. */
  width: 0.46,
  shrink: 0.25,
  /** Lines that are laid out either side of the one being sung. */
  before: 2,
  after: 3,
  /** The height of a row of letters and the space between lines (em). */
  rowHeight: 1.18,
  gap: 0.34,
  /** The translation under a line: its size relative to the line. */
  trans: 0.46,
  /** Jump and swell of the letters with their band. */
  jump: 0.3,
  swell: 0.2,
} as const;

/** How the lines recede: by their distance (in lines) from the one being sung, −2 … 3. */
const SLOT = {
  scale: { "-2": 0.4, "-1": 0.58, "0": 1, "1": 0.62, "2": 0.46, "3": 0.36 },
  alpha: { "-2": 0.05, "-1": 0.26, "0": 1, "1": 0.52, "2": 0.2, "3": 0.07 },
  blur: { "-2": 0.9, "-1": 0.55, "0": 0, "1": 0.42, "2": 0.78, "3": 1 },
  tilt: { "-2": -0.5, "-1": -0.32, "0": 0, "1": 0.32, "2": 0.5, "3": 0.64 },
} as const;

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC","WenQuanYi Micro Hei",system-ui,sans-serif';
const ATLAS = { size: 2048, cell: 96, em: 64, halo: 12, shadow: 7 };
const PER_ROW = Math.floor(ATLAS.size / ATLAS.cell);
const CAPACITY = PER_ROW * PER_ROW;
const BANDS = 20;

interface Glyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** The letters, drawn once each into one texture. */
class GlyphAtlas {
  readonly canvas = document.createElement("canvas");
  readonly texture: THREE.CanvasTexture;
  private readonly context: CanvasRenderingContext2D;
  private readonly glyphs = new Map<string, Glyph>();
  private readonly widths = new Map<string, number>();
  private used = 0;
  private dirty = false;
  /** Counts the times the atlas was wiped: a line built before the last wipe points at letters that are no longer there. */
  generation = 0;

  constructor() {
    this.canvas.width = this.canvas.height = ATLAS.size;
    const context = this.canvas.getContext("2d", { willReadFrequently: false });
    if (!context) throw new Error("no 2d canvas for the lyrics");
    this.context = context;
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, ATLAS.size, ATLAS.size);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = false;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 1;
  }

  /** The advance of a letter, in em. */
  advance(ch: string): number {
    let width = this.widths.get(ch);
    if (width === undefined) {
      this.context.font = `600 ${ATLAS.em}px ${FONT}`;
      width = Math.min(2, Math.max(0.2, this.context.measureText(ch).width / ATLAS.em));
      this.widths.set(ch, width);
    }
    return width;
  }

  has(ch: string): boolean {
    return this.glyphs.has(ch);
  }

  /** Whether `count` more letters fit. */
  room(count: number): boolean {
    return this.used + count <= CAPACITY;
  }

  /** The letter's place in the atlas; drawn on first use. */
  glyph(ch: string): Glyph {
    let glyph = this.glyphs.get(ch);
    if (glyph) return glyph;
    if (this.used >= CAPACITY) this.clear();
    const index = this.used++;
    const x0 = (index % PER_ROW) * ATLAS.cell;
    const y0 = Math.floor(index / PER_ROW) * ATLAS.cell;
    this.draw(ch, x0, y0);
    const inset = 0.5;
    glyph = { u0: (x0 + inset) / ATLAS.size, v0: (y0 + inset) / ATLAS.size, u1: (x0 + ATLAS.cell - inset) / ATLAS.size, v1: (y0 + ATLAS.cell - inset) / ATLAS.size };
    this.glyphs.set(ch, glyph);
    this.dirty = true;
    return glyph;
  }

  /** Send what was drawn since the last time to the graphics card. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  /** Forget every letter (the song changed, or the atlas is full). */
  clear() {
    this.glyphs.clear();
    this.used = 0;
    this.generation++;
    this.context.globalCompositeOperation = "source-over";
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, ATLAS.size, ATLAS.size);
    this.dirty = true;
  }

  private draw(ch: string, x0: number, y0: number) {
    const context = this.context;
    context.save();
    context.beginPath();
    context.rect(x0, y0, ATLAS.cell, ATLAS.cell);
    context.clip();
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "#000";
    context.fillRect(x0, y0, ATLAS.cell, ATLAS.cell);
    context.font = `600 ${ATLAS.em}px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    const cx = x0 + ATLAS.cell / 2;
    const by = y0 + ATLAS.cell / 2 + ATLAS.em * 0.34;
    // The channels are added: blue the dilated shadow, green the glow, red the letter itself.
    context.globalCompositeOperation = "lighter";
    context.lineJoin = "round";
    context.strokeStyle = "#0000ff";
    context.lineWidth = ATLAS.shadow * 2;
    context.shadowColor = "#0000ff";
    context.shadowBlur = 5;
    context.strokeText(ch, cx, by);
    context.shadowColor = "#00ff00";
    context.shadowBlur = ATLAS.halo;
    context.fillStyle = "#00ff00";
    context.fillText(ch, cx, by);
    context.fillText(ch, cx, by);
    context.shadowBlur = 0;
    context.fillStyle = "#ff0000";
    context.fillText(ch, cx, by);
    context.restore();
  }

  dispose() {
    this.texture.dispose();
  }
}

// ───────────────────────────────────────────── the shaders ─────────────────────────────────────────────

const VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aRect;
attribute vec4 aPlace;
attribute vec4 aMeta;
uniform float uEm;
uniform vec3 uOrigin;
uniform vec3 uAxisX;
uniform vec3 uAxisY;
uniform vec3 uToward;
uniform float uTime;
uniform float uBass;
uniform float uBands[${BANDS}];
uniform float uAge;
uniform float uSung;
uniform float uFocus;
uniform float uScale;
uniform float uY;
uniform float uAlpha;
uniform float uBlur;
uniform float uTilt;
uniform float uCalm;
varying vec2 vUv;
varying float vSung;
varying float vAlpha;
varying float vBlur;
varying float vPulse;

float bandAt(float x) {
  float f = clamp(x, 0.0, 1.0) * ${(BANDS - 1).toFixed(1)};
  int i = int(floor(f));
  int j = min(i + 1, ${BANDS - 1});
  return mix(uBands[i], uBands[j], f - float(i));
}

void main() {
  float t = aPlace.w;
  float live = (1.0 - uCalm);
  // The band under this letter, and the flash that runs along the line when it begins.
  float band = bandAt(t) * live;
  float amp = aMeta.y * (0.22 + 0.78 * uFocus);
  float sweep = exp(-pow((uAge - t * 0.5) * 5.5, 2.0)) * uFocus * live;
  float jump = (${LYRICS.jump.toFixed(3)} * band + 0.16 * sweep) * amp;
  float grow = 1.0 + ${LYRICS.swell.toFixed(3)} * band * amp + 0.26 * sweep + 0.05 * uBass * uFocus * live;
  // The letter's quad: half a cell is 0.75 em; a hair of rotation that follows the band.
  float rot = (aMeta.x - 0.5) * 0.4 * band * amp;
  float cr = cos(rot);
  float sr = sin(rot);
  vec2 c = aCorner * 0.75 * aPlace.z * grow;
  vec2 q = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr);
  // A slow drift of its own, so that a line at rest is not dead.
  float bob = sin(uTime * 1.3 + aMeta.x * 6.2831853 + t * 3.0) * 0.012 * live;
  vec2 p = (aPlace.xy + vec2(0.0, (jump + bob) * aPlace.z) + q) * uScale;
  // The line leans away from the viewer by its tilt (a drum seen from the front).
  float ct = cos(uTilt);
  float st = sin(uTilt);
  float y = uY + p.y * ct;
  float z = p.y * st;
  vec3 world = uOrigin + uAxisX * (p.x * uEm) + uAxisY * (y * uEm) + uToward * (z * uEm);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  vUv = vec2(mix(aRect.x, aRect.z, aCorner.x * 0.5 + 0.5), mix(aRect.w, aRect.y, aCorner.y * 0.5 + 0.5));
  vSung = smoothstep(aMeta.z - 0.05, aMeta.z + 0.07, uSung);
  vAlpha = uAlpha;
  vBlur = uBlur;
  vPulse = clamp(band * 0.9 * uFocus + sweep * 0.8, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vSung;
varying float vAlpha;
varying float vBlur;
varying float vPulse;

void main() {
  vec3 tex = texture2D(uAtlas, vUv).rgb;
  float core = tex.r;
  float halo = tex.g;
  float back = tex.b;
  // The lines far from the one being sung are out of focus: the sharp letter melts into its own glow.
  float body = mix(core, halo * 0.6, vBlur);
  float dark = mix(back, halo, vBlur) * 0.72;
  // The grade of the picture smears whatever is brighter than 0.95 along its width (the anamorphic streak, made for the disk's hot
  // points): the words are kept just under that, or they would be echoed sideways. The music's flash is in the glow and the size.
  // The words should sit in the picture, not become a white light source: a
  // quieter ivory, an amber sung highlight, and a small bloom contribution.
  vec3 white = vec3(0.72, 0.70, 0.67);
  vec3 gold = vec3(0.82, 0.57, 0.25);
  vec3 ink = mix(white, gold, vSung);
  vec3 glow = vec3(0.70, 0.40, 0.14) * halo * (0.035 + 0.16 * vPulse) * (0.3 + 0.7 * vSung) * (1.0 - vBlur);
  vec3 rgb = min((ink * body + glow) * vAlpha, vec3(0.78));
  gl_FragColor = vec4(rgb, dark * vAlpha);
  #include <colorspace_fragment>
}`;

// ───────────────────────────────────────────── the lines ─────────────────────────────────────────────

export interface Row {
  text: string;
  /** Size relative to the line, and how much of the music's jump it takes. */
  scale: number;
  bounce: number;
}

export interface Layout {
  rows: Row[];
  /** The height of the whole line (em, before it is scaled by its place). */
  height: number;
}

class Line {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly y: Spring = { value: 0, velocity: 0 };
  readonly scale: Spring = { value: 0.5, velocity: 0 };
  readonly alpha: Spring = { value: 0, velocity: 0 };
  readonly blur: Spring = { value: 1, velocity: 0 };
  readonly tilt: Spring = { value: 0, velocity: 0 };
  readonly focus: Spring = { value: 0, velocity: 0 };
  /** Seconds since this line became the one being sung. */
  age = 99;
  /** Not yet placed: it starts at its slot (a little low and clear) and comes up into it. */
  fresh = true;

  constructor(
    readonly index: number,
    readonly height: number,
    readonly generation: number,
    geometry: THREE.BufferGeometry,
    material: THREE.ShaderMaterial,
  ) {
    this.material = material;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900;
    this.mesh.userData.excludeFromAO = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Where a line of the window stands (see `stackSlots`). */
export interface Slot {
  y: number;
  scale: number;
  alpha: number;
  blur: number;
  tilt: number;
}

const isBreak = (ch: string) => ch === " " || "，。、；：！？,.;:!?—-）)」』》".includes(ch);

/**
 * Break a line into rows no wider than `max` em (at spaces and punctuation where it can; a line has at most three rows, and the last may
 * be wider: it is made smaller to fit), and put its translation under it. `advance` is the width of a letter in em.
 */
export function breakRows(text: string, trans: string | undefined, max: number, advance: (ch: string) => number, title = false): Layout {
  const rows: Row[] = [];
  const chars = Array.from(text.trim() || "·");
  let start = 0;
  let width = 0;
  let lastBreak = -1;
  for (let i = 0; i < chars.length; i++) {
    width += advance(chars[i]);
    if (isBreak(chars[i])) lastBreak = i;
    if (width > max && i > start && rows.length < 2) {
      const cut = lastBreak > start + (i - start) * 0.4 ? lastBreak + 1 : i;
      rows.push({ text: chars.slice(start, cut).join(""), scale: 1, bounce: 1 });
      start = cut;
      width = 0;
      for (let k = start; k <= i; k++) width += advance(chars[k]);
      lastBreak = -1;
    }
  }
  rows.push({ text: chars.slice(start).join(""), scale: 1, bounce: 1 });
  if (trans && trans.trim()) rows.push({ text: trans.trim(), scale: title ? 0.5 : LYRICS.trans, bounce: 0 });
  const height = rows.reduce((sum, row) => sum + LYRICS.rowHeight * row.scale, 0);
  return { rows, height };
}

/**
 * Where each line of the window stands: the one being sung (`current`) in the middle, the others piled up and down by their heights
 * (`heightOf`, em), each smaller, fainter and more out of focus than the one before it (see `SLOT`). `y` is up from the middle (em).
 */
export function stackSlots(current: number, heightOf: (index: number) => number, goal: Map<number, Slot> = new Map()): Map<number, Slot> {
  goal.clear();
  goal.set(current, { y: 0, scale: 1, alpha: 1, blur: 0, tilt: 0 });
  for (const direction of [1, -1]) {
    // `edge` is the far edge of the last line laid out: below the middle for 1, above it for −1.
    let edge = (-direction * heightOf(current)) / 2;
    const count = direction === 1 ? LYRICS.after : LYRICS.before;
    for (let k = 1; k <= count; k++) {
      const d = direction * k;
      const scale = lookup(SLOT.scale, d);
      const height = heightOf(current + d) * scale;
      edge -= direction * LYRICS.gap * scale;
      goal.set(current + d, { y: edge - (direction * height) / 2, scale, alpha: lookup(SLOT.alpha, d), blur: lookup(SLOT.blur, d), tilt: lookup(SLOT.tilt, d) });
      edge -= direction * height;
    }
  }
  return goal;
}

/**
 * How far through its line the singer is (0 … 1.2: the past counts as more than all of it): the letters of line `index` turn gold as the
 * singer passes them. `current` is the line being sung; without lines (the title) everything is sung.
 */
export function sungShare(lines: readonly LyricLine[] | null, index: number, current: number, positionMs: number): number {
  if (!lines) return 1.2;
  if (index < current) return 1.2;
  if (index > current) return 0;
  const start = lines[index].t;
  if (start < 0) return 0;
  const next = index + 1 < lines.length ? lines[index + 1].t : start + 5000;
  // The singer is done a little before the next line starts, and no line lasts longer than eight seconds.
  const length = Math.max(600, Math.min(8000, (next - start) * 0.82));
  return Math.max(0, Math.min(1.2, (positionMs - start) / length));
}

export class LyricsLayer {
  readonly group = new THREE.Group();
  private readonly atlas = new GlyphAtlas();
  private readonly bands = new Float32Array(BANDS);
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly lines = new Map<number, Line>();
  private readonly goal = new Map<number, Slot>();
  private id = Number.NaN;
  private source: readonly LyricLine[] | null = null;
  private current = -2;
  private widthEm = 11;
  private readonly origin = new THREE.Vector3();
  private shownMix = 0;
  /** The width (em) the lines were laid out for. */
  private laidOut = 0;
  /** Everything that is shown in the middle when the song has no lines (the title). */
  private titleKey = "";

  constructor() {
    this.group.visible = false;
    this.shared = {
      uAtlas: { value: this.atlas.texture },
      uEm: { value: 1 },
      uOrigin: { value: this.origin },
      uAxisX: { value: new THREE.Vector3(1, 0, 0) },
      uAxisY: { value: new THREE.Vector3(0, 1, 0) },
      uToward: { value: new THREE.Vector3(0, 0, 1) },
      uTime: { value: 0 },
      uBass: { value: 0 },
      uBands: { value: this.bands },
      uCalm: { value: 0 },
    };
  }

  /** True while anything is shown (the stage keeps drawing). */
  get active(): boolean {
    return this.group.visible;
  }

  /** The world is not shown: nothing is drawn (and the lines come in afresh next time). */
  hide() {
    this.group.visible = false;
    this.shownMix = 0;
  }

  update(frame: LyricsFrame) {
    const { state, system, eye, mix, reveal, dt } = frame;
    this.shownMix = frame.calm ? mix : this.shownMix + (mix - this.shownMix) * Math.min(1, dt * 4);
    const visible = state !== null && this.shownMix > 0.01;
    if (!visible || !state) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Where and how large: in front of the hole, a share of the picture's height; the whole block is smaller while the cards are out
    // (the lines keep their breaks: only a change of the window's shape lays them out again).
    const clamped = Math.max(0, Math.min(1, reveal));
    const out = clamped * clamped * (3 - 2 * clamped);
    const em = LYRICS.em * eye.halfHeight;
    this.widthEm = Math.max(4, (2 * eye.halfWidth * LYRICS.width) / em);
    const uniforms = this.shared;
    (uniforms.uEm as { value: number }).value = em * (1 - LYRICS.shrink * out);
    this.origin.set(system.centre[0], system.centre[1], system.centre[2]);
    (uniforms.uAxisX.value as THREE.Vector3).set(system.across[0], system.across[1], system.across[2]);
    (uniforms.uAxisY.value as THREE.Vector3).set(system.up[0], system.up[1], system.up[2]);
    (uniforms.uToward.value as THREE.Vector3).set(system.toward[0], system.toward[1], system.toward[2]);
    (uniforms.uTime as { value: number }).value = frame.time % 4000;
    (uniforms.uBass as { value: number }).value = frame.bass;
    (uniforms.uCalm as { value: number }).value = frame.calm ? 1 : 0;
    const audio = frame.audio;
    for (let i = 0; i < BANDS; i++) this.bands[i] = audio ? Math.min(1, audio.at(i / (BANDS - 1)) * 1.25) : 0;

    this.sync(state);
    this.advance(state, frame, out);
    this.atlas.flush();
  }

  // ───────────────────────────── the lines of the song ─────────────────────────────

  /** Make the lines that stand either side of the current one, and drop the ones that are out of the window. */
  private sync(state: LyricsState) {
    const lines = state.lines && state.lines.length > 0 ? state.lines : null;
    const key = `${state.title}|${state.subtitle}`;
    if (state.id !== this.id || lines !== this.source || (lines === null && key !== this.titleKey)) {
      this.id = state.id;
      this.source = lines;
      this.titleKey = key;
      this.dropLines();
      this.current = -2;
      this.atlas.clear();
      if (lines) this.prepare(lines);
    } else {
      // The window changed shape (the lines break differently), or the atlas was wiped under the lines: lay them out again.
      const stale = Math.abs(this.widthEm - this.laidOut) > 0.04 * this.laidOut || [...this.lines.values()].some((line) => line.generation !== this.atlas.generation);
      if (stale) this.dropLines();
    }
    this.laidOut = this.widthEm;
    const current = lines ? Math.max(0, Math.min(lines.length - 1, state.index)) : 0;
    if (current !== this.current) {
      this.current = current;
      for (const line of this.lines.values()) line.age = line.index === current ? 0 : 99;
    }
    if (lines) {
      for (let d = -LYRICS.before; d <= LYRICS.after; d++) {
        const index = current + d;
        if (index < 0 || index >= lines.length || this.lines.has(index)) continue;
        const line = this.build(index, lines[index].text, lines[index].trans);
        if (index === current) line.age = 0;
        this.lines.set(index, line);
        this.group.add(line.mesh);
      }
    } else if (!this.lines.has(0)) {
      const line = this.build(0, state.title, state.subtitle, true);
      this.lines.set(0, line);
      this.group.add(line.mesh);
    }
  }

  private dropLines() {
    for (const line of this.lines.values()) {
      this.group.remove(line.mesh);
      line.dispose();
    }
    this.lines.clear();
  }

  /** Draw every letter of the song into the atlas in one go (one upload per song instead of one per line). */
  private prepare(lines: readonly LyricLine[]) {
    const seen = new Set<string>();
    for (const line of lines) for (const ch of line.text + (line.trans ?? "")) if (ch.trim()) seen.add(ch);
    if (!this.atlas.room(seen.size)) return;
    for (const ch of seen) this.atlas.glyph(ch);
  }

  // ───────────────────────────── layout and geometry ─────────────────────────────

  /** Break a line into rows no wider than the box (at spaces and punctuation where it can), and put its translation under it. */
  private layout(text: string, trans: string | undefined, title: boolean): Layout {
    return breakRows(text, trans, this.widthEm, (ch) => this.atlas.advance(ch), title);
  }

  private build(index: number, text: string, trans: string | undefined, title = false): Line {
    const layout = this.layout(text, trans, title);
    // Read before the letters are drawn: if the atlas has to be wiped for them, this line is already out of date and `sync` builds it again.
    const generation = this.atlas.generation;
    const geometry = this.geometry(layout);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      // Drawn last, over everything, adding its light and darkening only the little it needs to be read over the disk.
      transparent: true,
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
        ...this.shared,
        uAge: { value: 99 },
        uSung: { value: 0 },
        uFocus: { value: 0 },
        uScale: { value: 1 },
        uY: { value: 0 },
        uAlpha: { value: 0 },
        uBlur: { value: 1 },
        uTilt: { value: 0 },
      },
    });
    return new Line(index, layout.height, generation, geometry, material);
  }

  private geometry(layout: Layout): THREE.BufferGeometry {
    const entries: { ch: string; x: number; y: number; size: number; order: number; reading: number; bounce: number; seed: number }[] = [];
    let top = layout.height / 2;
    // The letters of the line in the order they are sung (the rows of the line, not its translation): the gold follows this.
    const total = layout.rows.reduce((sum, row) => sum + (row.bounce > 0 ? Array.from(row.text).filter((ch) => ch.trim()).length : 0), 0);
    let read = 0;
    for (const row of layout.rows) {
      const chars = Array.from(row.text).filter((ch) => ch !== "\n");
      let width = 0;
      for (const ch of chars) width += this.atlas.advance(ch);
      // A row wider than the box (one long word) is made smaller to fit it.
      const fit = width * row.scale > this.widthEm ? this.widthEm / (width * row.scale) : 1;
      const size = row.scale * fit;
      let x = (-width * size) / 2;
      const y = top - (LYRICS.rowHeight * row.scale) / 2;
      let n = 0;
      const visible = chars.filter((ch) => ch.trim()).length;
      for (const ch of chars) {
        const advance = this.atlas.advance(ch) * size;
        if (ch.trim()) {
          const order = visible > 1 ? n / (visible - 1) : 0.5;
          const reading = row.bounce > 0 ? (total > 1 ? read / (total - 1) : 0.5) : order;
          entries.push({ ch, x: x + advance / 2, y, size, order, reading, bounce: row.bounce, seed: pseudo(entries.length + 1) });
          n++;
          if (row.bounce > 0) read++;
        }
        x += advance;
      }
      top -= LYRICS.rowHeight * row.scale;
    }
    const count = entries.length;
    const corner = new Float32Array(count * 8);
    const rect = new Float32Array(count * 16);
    const place = new Float32Array(count * 16);
    const meta = new Float32Array(count * 16);
    const index = new Uint16Array(count * 6);
    const position = new Float32Array(count * 12);
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    entries.forEach((entry, g) => {
      const glyph = this.atlas.glyph(entry.ch);
      for (let v = 0; v < 4; v++) {
        const at = g * 4 + v;
        corner[at * 2] = corners[v * 2];
        corner[at * 2 + 1] = corners[v * 2 + 1];
        rect.set([glyph.u0, glyph.v0, glyph.u1, glyph.v1], at * 4);
        place.set([entry.x, entry.y, entry.size, entry.order], at * 4);
        meta.set([entry.seed, entry.bounce, entry.reading, 0], at * 4);
      }
      index.set([g * 4, g * 4 + 1, g * 4 + 2, g * 4, g * 4 + 2, g * 4 + 3], g * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
    geometry.setAttribute("aRect", new THREE.BufferAttribute(rect, 4));
    geometry.setAttribute("aPlace", new THREE.BufferAttribute(place, 4));
    geometry.setAttribute("aMeta", new THREE.BufferAttribute(meta, 4));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    return geometry;
  }

  // ───────────────────────────── motion ─────────────────────────────

  /**
   * Where each line of the window stands: the one being sung in the middle, the others piled up and down by their heights, each
   * smaller, fainter and more out of focus than the one before it (see `SLOT`).
   */
  private stack(current: number): Map<number, Slot> {
    return stackSlots(current, (index) => this.lines.get(index)?.height ?? LYRICS.rowHeight, this.goal);
  }

  /** Move every line to its place in the stack, and tell its material how far the singer has got. */
  private advance(state: LyricsState, frame: LyricsFrame, out: number) {
    const dt = Math.min(frame.dt, 0.05);
    const current = this.current;
    const goal = this.stack(current);
    const rate = frame.calm ? 40 : 6.5;
    // With the cards out the whole block is a little dimmer.
    const dim = 1 - 0.2 * out;
    for (const [index, line] of this.lines) {
      const slot = goal.get(index);
      line.age += dt;
      if (!slot) {
        // Out of the window: fade away, then go.
        damp(line.alpha, 0, rate, dt);
        line.material.uniforms.uAlpha.value = Math.max(0, line.alpha.value) * dim * this.shownMix;
        if (line.alpha.value < 0.01) {
          this.group.remove(line.mesh);
          line.dispose();
          this.lines.delete(index);
        }
        continue;
      }
      if (line.fresh) {
        // A new line starts at its slot (a little low, small and out of focus) and comes up into it.
        line.fresh = false;
        line.y.value = slot.y - 0.5 * slot.scale;
        line.scale.value = slot.scale * 0.85;
        line.blur.value = 1;
        line.tilt.value = slot.tilt;
        line.alpha.value = frame.calm ? slot.alpha : 0;
      }
      damp(line.y, slot.y, rate, dt);
      damp(line.scale, slot.scale, rate, dt);
      damp(line.alpha, slot.alpha, rate, dt);
      damp(line.blur, slot.blur, rate, dt);
      damp(line.tilt, slot.tilt, rate, dt);
      damp(line.focus, index === current ? 1 : 0, rate * 0.8, dt);
      const uniforms = line.material.uniforms;
      uniforms.uY.value = line.y.value;
      uniforms.uScale.value = Math.max(0.01, line.scale.value);
      uniforms.uAlpha.value = Math.max(0, line.alpha.value) * dim * this.shownMix;
      uniforms.uBlur.value = Math.min(1, Math.max(0, line.blur.value));
      uniforms.uTilt.value = line.tilt.value;
      uniforms.uFocus.value = Math.min(1, Math.max(0, line.focus.value));
      uniforms.uAge.value = Math.min(line.age, 99);
      uniforms.uSung.value = this.sung(index, state);
    }
  }

  /** How far through the line the singer is (0 … 1.2: the past is more than all of it): the letters turn gold as it passes them. */
  private sung(index: number, state: LyricsState): number {
    return sungShare(this.source, index, this.current, state.positionMs);
  }

  dispose() {
    for (const line of this.lines.values()) line.dispose();
    this.lines.clear();
    this.atlas.dispose();
  }
}

/** A number from 0 to 1 that is always the same for the same input (each letter's own little difference). */
function pseudo(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function lookup(table: Record<string, number>, d: number): number {
  const key = String(Math.max(-2, Math.min(3, d)));
  return table[key] ?? 0;
}
