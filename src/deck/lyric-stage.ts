import * as THREE from "three";
import { DRUM, drumSlot, lineFill, type DrumShape } from "./model";
import { Print } from "./print";

/**
 * Lyrics in depth: the lines hang on a drum that turns about a horizontal axis. The line that is sung stands in front,
 * big and sharp, and fills with colour as it is sung; the lines before and after it curve away into the distance, fainter
 * and more out of focus the farther they are (the blur is the texture's mip level, so it costs nothing), and the drum turns
 * smoothly to the next line when its time comes. The same stage serves the music page of the launcher and the lyrics window
 * on the desktop, which is why it knows nothing of either: it is a group of planes that its owner puts in a scene.
 *
 * Coordinates are px at scale 1 with the middle of the drum at the group's origin; `scale` (the owner's layout scale) is
 * applied to everything at once.
 */

export interface StageLine {
  /** Start in ms (−1 when the lyrics carry no times). */
  t: number;
  text: string;
  trans?: string;
}

export interface LyricLook {
  /** Colour of a line that is not sung, and of the part that is (CSS colours). */
  ink: string;
  sung: string;
  /** Font size of the main row and of the translation row, px at scale 1. */
  size: number;
  transSize: number;
  weight: string;
  align: "left" | "center";
  /** A dark edge around the letters, so that the lyrics read over any desktop picture. 0 = none, else the width in px. */
  outline: number;
  /** Family of the letters. */
  font: string;
}

export const LYRIC_FONT = "'LXGW WenKai', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";

export const DEFAULT_LOOK: LyricLook = { ink: "#171713", sung: "#b8843a", size: 34, transSize: 18, weight: "bold", align: "left", outline: 0, font: LYRIC_FONT };

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uBias;
uniform float uAlpha;
uniform float uFill;
uniform float uFocus;
uniform vec2 uSpan;
uniform vec2 uBand;
uniform vec3 uInk;
uniform vec3 uSung;
uniform vec2 uTexel;
uniform float uOutline;
varying vec2 vUv;

void main() {
  float a = texture2D(uMap, vUv, uBias).a;
  float edge = mix(uSpan.x, uSpan.y, uFill);
  float inBand = step(uBand.x, vUv.y) * step(vUv.y, uBand.y);
  float sung = uFocus * inBand * smoothstep(edge + 0.006, edge - 0.006, vUv.x);
  vec3 colour = mix(uInk, uSung, sung);
  float alpha = a;
  if (uOutline > 0.0) {
    // A dilation of the letters, drawn in black underneath them.
    float grow = a;
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.785398;
      vec2 offset = vec2(cos(angle), sin(angle)) * uTexel * uOutline;
      grow = max(grow, texture2D(uMap, vUv + offset, uBias).a);
    }
    vec3 edgeColour = vec3(0.02, 0.03, 0.04);
    colour = mix(edgeColour, colour, a);
    alpha = max(a, grow * 0.62);
  }
  gl_FragColor = vec4(colour, alpha * uAlpha);
  #include <colorspace_fragment>
}`;

interface LineView {
  index: number;
  mesh: THREE.Mesh;
  print: Print;
  material: THREE.ShaderMaterial;
  focus: number;
  height: number;
}

const FOCUS_RATE = 9;
const TURN_RATE = 8;
/** How long a hand-scrolled drum stays where the user left it before it turns back to the line that is sung. */
const MANUAL_MS = 3200;

export class LyricStage {
  readonly group = new THREE.Group();
  /** Everything fades with this (the owner's fade in and out). */
  opacity = 1;
  private lines: StageLine[] = [];
  private message = "";
  private readonly views = new Map<number, LineView>();
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private pos = 0;
  private manual: number | null = null;
  private manualAt = 0;
  private width: number;
  private scale = 1;
  private pixelRatio: number;
  private look: LyricLook;
  private shape: DrumShape;
  private lastIndex = -2;
  private clock = 0;

  constructor(options: { width: number; look?: Partial<LyricLook>; shape?: DrumShape; pixelRatio?: number }) {
    this.width = options.width;
    this.look = { ...DEFAULT_LOOK, ...options.look };
    this.shape = options.shape ?? DRUM;
    this.pixelRatio = options.pixelRatio ?? Math.min(2, window.devicePixelRatio || 1);
  }

  // ───────────────────────────────────────────── what is shown ─────────────────────────────────────────────

  /** The lines to show; `message` is printed alone in the middle instead when there are none ("纯音乐，请欣赏"). */
  setLines(lines: readonly StageLine[] | null, message = "") {
    this.lines = lines ? lines.slice() : [];
    this.message = this.lines.length ? "" : message;
    this.manual = null;
    this.pos = 0;
    this.lastIndex = -2;
    this.clearViews();
  }

  get count(): number {
    return this.lines.length;
  }

  /** Width (px at scale 1) of the lines, and the owner's scale. */
  setLayout(width: number, scale: number) {
    if (width !== this.width) {
      this.width = width;
      this.clearViews();
    }
    this.scale = scale;
  }

  setLook(look: Partial<LyricLook>) {
    this.look = { ...this.look, ...look };
    this.repaint();
  }

  setPixelRatio(pixelRatio: number) {
    if (pixelRatio === this.pixelRatio) return;
    this.pixelRatio = pixelRatio;
    this.clearViews();
  }

  /** Print every line again (fonts that arrived late, a changed look). */
  repaint() {
    for (const view of this.views.values()) view.print.invalidate();
  }

  /** The user turned the drum by hand (wheel): it stays there for a while, then returns to the line that is sung. */
  scrollBy(lines: number, now: number) {
    if (!this.lines.length) return;
    const from = this.manual ?? this.pos;
    this.manual = Math.max(0, Math.min(this.lines.length - 1, from + lines));
    this.manualAt = now;
  }

  // ───────────────────────────────────────────── every frame ─────────────────────────────────────────────

  /**
   * Turn the drum, fill the line that is sung, and place every line. `index` is the line that is sung now (−1: none yet) and
   * `ms` the position in the song. Returns true while anything is still moving.
   */
  update(dt: number, ms: number, index: number, now: number): boolean {
    this.clock = now;
    if (this.manual !== null && now - this.manualAt > MANUAL_MS) this.manual = null;
    const timed = this.lines.length > 0 && this.lines[0].t >= 0;
    const goal = this.message ? 0 : this.manual !== null ? this.manual : timed ? Math.max(0, index) : this.pos;
    const before = this.pos;
    this.pos += (goal - this.pos) * (1 - Math.exp(-TURN_RATE * dt));
    let moving = Math.abs(goal - this.pos) > 0.002;
    if (!moving) this.pos = goal;
    if (this.pos !== before) moving = true;

    // The lines that can be seen: a few either side of the front.
    const first = Math.max(0, Math.floor(this.pos) - 5);
    const last = Math.min(Math.max(0, this.lines.length - 1), Math.ceil(this.pos) + 5);
    const wanted = new Set<number>();
    if (this.message) wanted.add(0);
    else for (let i = first; i <= last && this.lines.length; i++) wanted.add(i);
    for (const [i, view] of this.views) if (!wanted.has(i)) this.drop(i, view);
    for (const i of wanted) if (!this.views.has(i)) this.views.set(i, this.makeView(i));

    for (const view of this.views.values()) {
      const d = view.index - this.pos;
      const slot = drumSlot(d, this.shape);
      const isCurrent = !this.message && view.index === index;
      const focusBefore = view.focus;
      view.focus += ((isCurrent ? 1 : 0) - view.focus) * (1 - Math.exp(-FOCUS_RATE * dt));
      if (Math.abs((isCurrent ? 1 : 0) - view.focus) < 0.004) view.focus = isCurrent ? 1 : 0;
      if (view.focus !== focusBefore) moving = true;
      this.print(view);
      const k = this.scale * slot.scale * (1 + 0.06 * view.focus);
      const mesh = view.mesh;
      mesh.position.set(0, slot.y * this.scale, slot.z * this.scale);
      mesh.rotation.x = slot.tilt;
      mesh.scale.set(this.width * k, view.height * k, 1);
      // The line is placed by its middle row, so that a translation under it does not shift the main row.
      const uniforms = view.material.uniforms;
      uniforms.uAlpha.value = (this.message ? 1 : slot.alpha * (0.85 + 0.15 * view.focus)) * this.opacity;
      uniforms.uBias.value = slot.blur;
      uniforms.uFocus.value = this.message ? 0 : view.focus;
      uniforms.uFill.value = this.message ? 0 : view.index < index ? 1 : view.index > index ? 0 : lineFill(this.lines, view.index, ms);
      mesh.visible = slot.alpha > 0.02;
    }
    if (index !== this.lastIndex) {
      this.lastIndex = index;
      moving = true;
    }
    if (isFinite(ms) && this.lines.length && timed && index >= 0 && index < this.lines.length) {
      // The fill moves while a line is being sung.
      const fill = lineFill(this.lines, index, ms);
      if (fill > 0 && fill < 1) moving = true;
    }
    return moving;
  }

  /** The line under a ray (the nearest one that can be seen), or null. */
  pick(raycaster: THREE.Raycaster): number | null {
    const meshes = [...this.views.values()].filter((view) => view.mesh.visible && !this.message).map((view) => view.mesh);
    if (!meshes.length) return null;
    this.group.updateWorldMatrix(true, true);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? (hit.object.userData.index as number) : null;
  }

  dispose() {
    this.clearViews();
    this.geometry.dispose();
  }

  // ───────────────────────────────────────────── lines ─────────────────────────────────────────────

  private makeView(index: number): LineView {
    const line = this.lines[index];
    const text = this.message || line?.text || "";
    const rows = (line?.trans ? 1 : 0) + 1;
    const height = Math.ceil(this.look.size * 1.55 + (rows > 1 ? this.look.transSize * 1.6 : 0) + 10);
    const print = new Print(this.width, height, this.pixelRatio, true, 4);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uMap: { value: print.texture },
        uBias: { value: 0 },
        uAlpha: { value: 1 },
        uFill: { value: 0 },
        uFocus: { value: 0 },
        uSpan: { value: new THREE.Vector2(0, 1) },
        uBand: { value: new THREE.Vector2(0, 1) },
        uInk: { value: new THREE.Color(this.look.ink) },
        uSung: { value: new THREE.Color(this.look.sung) },
        uTexel: { value: new THREE.Vector2(1 / print.canvas.width, 1 / print.canvas.height) },
        uOutline: { value: this.look.outline * this.pixelRatio },
      },
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.userData.index = index;
    this.group.add(mesh);
    void text;
    return { index, mesh, print, material, focus: 0, height };
  }

  /** Print a line if what it shows changed (a new look, new fonts, another pixel ratio). */
  private print(view: LineView) {
    const line = this.lines[view.index];
    const text = this.message || line?.text || "";
    const trans = this.message ? "" : line?.trans ?? "";
    const look = this.look;
    const key = [text, trans, look.size, look.transSize, look.weight, look.align, look.font, look.ink, look.sung, look.outline].join("|");
    const uniforms = view.material.uniforms;
    (uniforms.uInk.value as THREE.Color).set(look.ink);
    (uniforms.uSung.value as THREE.Color).set(look.sung);
    uniforms.uOutline.value = look.outline * this.pixelRatio;
    view.print.paint(key, (ctx, w, h) => {
      const pad = 8 + look.outline;
      const room = w - pad * 2;
      let size = look.size;
      ctx.font = `${look.weight} ${size}px ${look.font}`;
      while (ctx.measureText(text).width > room && size > look.size * 0.6) {
        size -= 2;
        ctx.font = `${look.weight} ${size}px ${look.font}`;
      }
      let shown = text;
      if (ctx.measureText(shown).width > room) {
        while (shown.length > 1 && ctx.measureText(`${shown}…`).width > room) shown = shown.slice(0, -1);
        shown = `${shown}…`;
      }
      const width = ctx.measureText(shown).width;
      const x = look.align === "center" ? (w - width) / 2 : pad;
      const baseline = size * 1.15 + 3;
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText(shown, x, baseline);
      // Where the sung part of the main row ends at each moment: the span of its letters, and the band of the canvas it is in.
      (uniforms.uSpan.value as THREE.Vector2).set(x / w, (x + width) / w);
      (uniforms.uBand.value as THREE.Vector2).set(1 - (size * 1.15 + 3 + size * 0.38) / h, 1 - (baseline - size * 1.05) / h);
      if (trans) {
        let tsize = look.transSize;
        ctx.font = `normal ${tsize}px ${look.font}`;
        while (ctx.measureText(trans).width > room && tsize > look.transSize * 0.65) {
          tsize -= 1;
          ctx.font = `normal ${tsize}px ${look.font}`;
        }
        let cut = trans;
        if (ctx.measureText(cut).width > room) {
          while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
          cut = `${cut}…`;
        }
        const tx = look.align === "center" ? (w - ctx.measureText(cut).width) / 2 : pad;
        ctx.globalAlpha = 0.72;
        ctx.fillText(cut, tx, baseline + tsize * 1.5 + 2);
      }
    });
    void this.clock;
  }

  private drop(index: number, view: LineView) {
    this.group.remove(view.mesh);
    view.material.dispose();
    view.print.dispose();
    this.views.delete(index);
  }

  private clearViews() {
    for (const [index, view] of [...this.views]) this.drop(index, view);
  }
}
