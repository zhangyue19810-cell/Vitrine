import * as THREE from "three";
import { RAIL_DARK, RAIL_LIGHT, paintDisc, type RailPalette } from "../rail/paint";
import { softDisc } from "../rail/shadow";
import type { SpectrumField } from "../spectrum";
import { LyricStage, LYRIC_FONT, type LyricLook, type StageLine } from "./lyric-stage";
import { ARM, DECK_TILT, FIN_COUNT, armAngle, armHead, armRest, deckLayout, finAngle, finPosition, pointToProgress, progressToRadius, type DeckLayout } from "./model";
import { FALLBACK_COLOURS, mixRgb, pickColours, type CoverColours, type Rgb } from "./palette";
import { Print } from "./print";

/**
 * The now-playing page of the music tab, all in three.js: a turntable with the record of the song (its label is the cover),
 * a ring of thin fins around it that jump with the music, a tonearm whose needle travels across the groove as the song goes
 * on (drag it to jump to another place), the title block, and the lyrics in depth. It draws on a transparent canvas of its
 * own between the archive stage and the control rail, and covers the stage with a backdrop tinted by the cover while it is
 * open. It knows nothing of the player: the host hands it a `DeckSource`, and gets a few events back.
 */

export interface DeckState {
  /** The page is wanted (it fades in and out by itself). */
  open: boolean;
  song: { title: string; artists: string; album: string } | null;
  /** Small print above the title: "正在播放", "已暂停", "仅试听片段"… */
  status: string;
  cover: CanvasImageSource | null;
  /** Changes whenever `cover` does. */
  coverId: number;
  playing: boolean;
  loading: boolean;
  /** 0 … 1, or null when the length is not known. */
  progress: number | null;
  positionMs: number;
  durationMs: number;
  lyrics: { lines: readonly StageLine[]; timed: boolean } | null;
  /** Changes whenever `lyrics` does. */
  lyricsId: number;
  lyricIndex: number;
  /** What the lyrics area says when there are no lines ("纯音乐，请欣赏", "暂无歌词", "在曲库里选一首歌…"). */
  lyricsNote: string;
  spectrum: SpectrumField | null;
  dark: boolean;
}

export interface DeckSource {
  read(): DeckState;
}

export interface DeckEvents {
  /** The record was clicked. */
  toggle(): void;
  /** The needle was dragged and let go at this fraction of the song. */
  seek(fraction: number): void;
  /** A line of the lyrics was clicked. */
  line(index: number): void;
  /** The wheel turned over the record (−1: quieter, +1: louder). */
  volume(direction: number): void;
}

const VINYL = 1024;
const RING_RADIUS = 1.22;
const FIN_MAX = 0.62;
const FIN_MIN = 0.03;
const APPEAR_RATE = 5.5;
const SPIN = 1.25;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const follow = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const rgbOf = (rgb: Rgb) => new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255).convertSRGBToLinear();

const BACKDROP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}`;

const BACKDROP_FRAGMENT = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform float uTime;
uniform float uDark;
uniform float uOpacity;
uniform vec2 uRes;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float t = uTime * 0.045;
  vec2 c1 = vec2(-0.46 + 0.09 * sin(t * 1.3), 0.02 + 0.07 * cos(t * 1.1));
  vec2 c2 = vec2(0.52 + 0.08 * cos(t * 0.9), -0.24 + 0.06 * sin(t * 1.7));
  vec2 c3 = vec2(0.10 + 0.11 * sin(t * 0.7), 0.42 + 0.05 * cos(t * 1.9));
  float m1 = exp(-dot(p - c1, p - c1) * 2.6);
  float m2 = exp(-dot(p - c2, p - c2) * 3.2);
  float m3 = exp(-dot(p - c3, p - c3) * 4.2);
  float k = mix(0.50, 0.60, uDark);
  vec3 col = uBase;
  col = mix(col, uA, m1 * k);
  col = mix(col, uB, m2 * k * 0.8);
  col = mix(col, uC, m3 * k * 0.65);
  float v = smoothstep(1.25, 0.25, length(p));
  col *= mix(mix(0.93, 0.78, uDark), 1.0, v);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) * 0.014;
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

export class DeckScene {
  events: Partial<DeckEvents> = {};
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /** The backdrop is drawn first, in a pass of its own, so that it lies under every solid object whatever their order. */
  private readonly backdropScene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 10, 9000);
  private source?: DeckSource;
  private state?: DeckState;
  private width = 1;
  private height = 1;
  private layout: DeckLayout = deckLayout({ width: 1280, height: 720 });
  private pixelRatio = 1;

  // objects
  private readonly backdrop: THREE.Mesh;
  private readonly backdropMaterial: THREE.ShaderMaterial;
  private readonly turntable = new THREE.Group();
  private readonly record = new THREE.Group();
  private readonly recordDisc: THREE.Mesh;
  private readonly fins: THREE.InstancedMesh;
  private readonly armYaw = new THREE.Group();
  private readonly armPitch = new THREE.Group();
  private readonly headHit: THREE.Mesh;
  private readonly materials: { plinth: THREE.MeshStandardMaterial; fin: THREE.MeshStandardMaterial; arm: THREE.MeshStandardMaterial; head: THREE.MeshStandardMaterial; platter: THREE.MeshStandardMaterial; weight: THREE.MeshStandardMaterial };
  private readonly vinyl = new Print(VINYL, VINYL, 1, true, 8);
  private readonly header = new Print(520, 124, 2);
  private readonly headerMesh: THREE.Mesh;
  private readonly tip = new Print(96, 34, 2);
  private readonly tipMesh: THREE.Mesh;
  private readonly flashPrint = new Print(128, 128, 2);
  private readonly flashMesh: THREE.Mesh;
  private readonly lyrics: LyricStage;
  private readonly shadowTexture = softDisc();
  private readonly lights: THREE.Light[] = [];
  private readonly finColour = new THREE.Color();
  private readonly baseFin = new THREE.Color();
  private readonly peakFin = new THREE.Color();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly hitPoint = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();

  // motion
  private appear = 0;
  private spin = 0;
  private spinRate = 0;
  private arm = armAngle(armRest());
  private lift = 1;
  private levels = new Float32Array(FIN_COUNT);
  private palette: RailPalette = RAIL_LIGHT;
  private colours: CoverColours = FALLBACK_COLOURS;
  private tint = { a: new THREE.Color(), b: new THREE.Color(), c: new THREE.Color() };
  private tintGoal = { a: new THREE.Color(), b: new THREE.Color(), c: new THREE.Color() };
  private tintMoving = false;
  private shown = { coverId: -1, dark: null as boolean | null, lyricsId: -1, song: "", status: "", cover: undefined as CanvasImageSource | null | undefined };
  private dirty = true;
  private time = 0;
  private lastIndex = -1;

  // pointer
  private hover: "head" | "record" | "line" | null = null;
  private drag: { progress: number } | null = null;
  private press: { kind: "head" | "record" | "line"; line: number | null; x: number; y: number } | null = null;
  private flash = 0;
  private flashPlaying = true;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute("aria-hidden", "true");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: "2", pointerEvents: "none", display: "none" });
    container.appendChild(this.canvas);

    // The backdrop.
    this.backdropMaterial = new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERTEX,
      fragmentShader: BACKDROP_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBase: { value: new THREE.Color() },
        uA: { value: new THREE.Color() },
        uB: { value: new THREE.Color() },
        uC: { value: new THREE.Color() },
        uTime: { value: 0 },
        uDark: { value: 0 },
        uOpacity: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backdropMaterial);
    this.backdrop.frustumCulled = false;
    this.backdropScene.add(this.backdrop);

    // Light.
    const ambient = new THREE.AmbientLight(0xffffff, 1.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-500, 800, 900);
    this.lights.push(ambient, key);
    this.scene.add(ambient, key);

    // The turntable: everything in it is in record radii, the plane of the plate is x/y, its normal +z.
    this.scene.add(this.turntable);
    this.turntable.rotation.x = -DECK_TILT;
    const standard = (color: string, roughness = 0.75, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials = {
      plinth: standard("#f0ebde", 0.85),
      platter: standard("#101314", 0.55, 0.1),
      fin: standard("#171713", 0.5),
      arm: standard("#f4f1e8", 0.4, 0.1),
      head: standard("#e8b967", 0.45),
      weight: standard("#1a1d1e", 0.5, 0.2),
    };
    const alongZ = (geometry: THREE.BufferGeometry) => {
      geometry.rotateX(Math.PI / 2);
      return geometry;
    };

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 4.2),
      new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, opacity: 0.34, depthWrite: false, color: 0x000000 }),
    );
    shadow.position.set(0.1, -0.22, -0.09);
    shadow.renderOrder = -5;
    this.turntable.add(shadow);

    const plinth = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(1.46, 1.46, 0.09, 96)), this.materials.plinth);
    plinth.position.z = -0.045;
    this.turntable.add(plinth);
    const platter = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(1.045, 1.045, 0.03, 96)), this.materials.platter);
    platter.position.z = 0.012;
    this.turntable.add(platter);

    // The record: black, the cover on its label (printed in `paintVinyl`).
    const vinylMaterials = [
      new THREE.MeshBasicMaterial({ color: 0x0a0c0d }),
      new THREE.MeshBasicMaterial({ map: this.vinyl.texture }),
      new THREE.MeshBasicMaterial({ color: 0x0a0c0d }),
    ];
    this.recordDisc = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(1, 1, 0.022, 128)), vinylMaterials);
    this.record.position.z = 0.04;
    this.record.add(this.recordDisc);
    this.turntable.add(this.record);
    const spindle = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 24)), this.materials.arm);
    spindle.position.z = 0.075;
    this.turntable.add(spindle);

    // The fins around the record.
    const finGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.fins = new THREE.InstancedMesh(finGeometry, this.materials.fin, FIN_COUNT);
    this.fins.frustumCulled = false;
    this.fins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < FIN_COUNT; i++) this.fins.setColorAt(i, this.finColour.setRGB(1, 1, 1));
    this.fins.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.turntable.add(this.fins);

    // The tonearm.
    const pivot = new THREE.Group();
    pivot.position.set(ARM.pivot.x, ARM.pivot.y, 0.06);
    this.turntable.add(pivot);
    const base = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(0.13, 0.15, 0.1, 40)), this.materials.arm);
    base.position.z = -0.02;
    pivot.add(base);
    const cap = new THREE.Mesh(alongZ(new THREE.CylinderGeometry(0.065, 0.065, 0.05, 32)), this.materials.weight);
    cap.position.z = 0.05;
    pivot.add(cap);
    pivot.add(this.armYaw);
    this.armYaw.add(this.armPitch);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, ARM.length, 20), this.materials.arm);
    tube.rotation.z = Math.PI / 2;
    tube.position.x = ARM.length / 2;
    this.armPitch.add(tube);
    const weight = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.17, 28), this.materials.weight);
    weight.rotation.z = Math.PI / 2;
    weight.position.x = -0.2;
    this.armPitch.add(weight);
    const shell = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.075, 0.03), this.materials.head);
    shell.position.x = ARM.length + 0.05;
    shell.rotation.z = -0.1;
    this.armPitch.add(shell);
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.002, 0.045, 10), this.materials.weight);
    needle.rotation.x = Math.PI / 2;
    needle.position.set(ARM.length + 0.1, 0, -0.035);
    this.armPitch.add(needle);
    this.headHit = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.headHit.position.x = ARM.length + 0.04;
    this.armPitch.add(this.headHit);

    // A small time label that follows the needle while it is dragged, and the glyph that flashes when the record is clicked.
    this.tipMesh = this.plate(this.tip, 96, 34);
    this.tipMesh.visible = false;
    this.flashMesh = this.plate(this.flashPrint, 128, 128);
    this.flashMesh.visible = false;
    this.headerMesh = this.plate(this.header, 520, 124);

    // The lyrics.
    this.lyrics = new LyricStage({ width: 520, look: this.lookFor(false), pixelRatio: 2 });
    this.scene.add(this.lyrics.group);

    this.scene.add(this.headerMesh, this.tipMesh, this.flashMesh);
    this.resize();
    this.applyTheme(false);
  }

  /** A flat plane showing a canvas (a label), placed in the picture's own pixel space. */
  private plate(print: Print, width: number, height: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: print.texture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    mesh.scale.set(width, height, 1);
    mesh.renderOrder = 5;
    return mesh;
  }

  setSource(source: DeckSource) {
    this.source = source;
    this.dirty = true;
  }

  /** The deck covers the archive stage completely (the host may stop drawing the stage while this is true). */
  get coversStage(): boolean {
    return this.appear > 0.995;
  }

  get visible(): boolean {
    return this.appear > 0.01;
  }

  /** Whether the deck wants presses and the wheel (it is open enough to be seen). */
  get active(): boolean {
    return this.appear > 0.5 && Boolean(this.state?.open);
  }

  // ───────────────────────────────────────────── size, theme, fonts ─────────────────────────────────────────────

  resize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (width === this.width && height === this.height && ratio === this.pixelRatio) return;
    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.position.set(0, 0, height / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.far = this.camera.position.z * 4;
    this.camera.updateProjectionMatrix();
    this.backdropMaterial.uniforms.uRes.value.set(width, height);
    this.layout = deckLayout({ width, height });
    this.place();
    this.dirty = true;
  }

  /** Put every object where the layout says. */
  private place() {
    const { record, lyrics, header, scale } = this.layout;
    const sx = (x: number) => x - this.width / 2;
    const sy = (y: number) => this.height / 2 - y;
    this.turntable.position.set(sx(record.cx), sy(record.cy), 0);
    this.turntable.scale.setScalar(record.radius);
    this.headerMesh.scale.set(header.width, (header.width / 520) * 124, 1);
    this.headerMesh.position.set(sx(header.x + header.width / 2), sy(header.y + ((header.width / 520) * 124) / 2), 0);
    this.lyrics.setLayout(lyrics.width / scale, scale);
    this.lyrics.group.position.set(sx(lyrics.x + lyrics.width / 2), sy(lyrics.y + lyrics.height / 2), 0);
    this.lyrics.setLook({ size: 34 });
  }

  private lookFor(dark: boolean): Partial<LyricLook> {
    const palette = dark ? RAIL_DARK : RAIL_LIGHT;
    return { ink: dark ? "#c9d4d1" : "#3b3a33", sung: dark ? palette.accent : palette.accentLow, size: 34, transSize: 18, align: "left", font: LYRIC_FONT };
  }

  setDark(dark: boolean) {
    this.applyTheme(dark);
  }

  private applyTheme(dark: boolean) {
    if (this.shown.dark === dark) return;
    this.shown.dark = dark;
    this.palette = dark ? RAIL_DARK : RAIL_LIGHT;
    const p = this.palette;
    this.materials.plinth.color.set(p.paper);
    this.materials.platter.color.set(dark ? "#06090a" : "#101314");
    this.materials.arm.color.set(dark ? "#d9e1de" : "#f4f1e8");
    this.materials.head.color.set(p.accent);
    this.baseFin.set(dark ? "#dfe8e5" : "#1c1c18");
    (this.backdropMaterial.uniforms.uBase.value as THREE.Color).set(dark ? "#0f1619" : "#eae5e1");
    this.backdropMaterial.uniforms.uDark.value = dark ? 1 : 0;
    this.lyrics.setLook(this.lookFor(dark));
    this.retint();
    this.header.invalidate();
    this.tip.invalidate();
    this.flashPrint.invalidate();
    this.shown.coverId = -2;
    this.dirty = true;
  }

  /** The cover colours, softened into the page: pale on paper, deep at night. */
  private retint() {
    const dark = this.shown.dark === true;
    const base: Rgb = dark ? [15, 22, 25] : [234, 229, 225];
    const soften = (colour: Rgb, amount: number) => rgbOf(mixRgb(colour, base, dark ? amount * 0.8 : amount));
    this.tintGoal.a.copy(soften(this.colours.vivid, 0.38));
    this.tintGoal.b.copy(soften(this.colours.second, 0.5));
    this.tintGoal.c.copy(soften(this.colours.third, 0.58));
    this.peakFin.copy(rgbOf(mixRgb(this.colours.vivid, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.1 : 0.05)));
    this.tintMoving = true;
  }

  /** The fonts of the labels arrived: print everything that has text again. */
  repaintAll() {
    this.header.invalidate();
    this.tip.invalidate();
    this.lyrics.repaint();
    this.dirty = true;
  }

  // ───────────────────────────────────────────── every frame ─────────────────────────────────────────────

  /** Advance everything by `dt` seconds and draw if anything changed. `time` is in seconds. */
  update(dt: number, time: number) {
    this.time = time;
    const state = this.source?.read();
    if (state) this.state = state;
    const wanted = Boolean(state?.open);
    const before = this.appear;
    this.appear += ((wanted ? 1 : 0) - this.appear) * follow(APPEAR_RATE, dt);
    if (Math.abs((wanted ? 1 : 0) - this.appear) < 0.002) this.appear = wanted ? 1 : 0;
    if (this.appear === 0 && !wanted) {
      if (this.canvas.style.display !== "none") this.canvas.style.display = "none";
      return;
    }
    if (!state) return;
    if (this.canvas.style.display === "none") {
      this.canvas.style.display = "block";
      this.dirty = true;
    }
    let moving = this.appear !== before || this.dirty;

    if (state.dark !== this.shown.dark) this.applyTheme(state.dark);
    this.syncContent(state);

    // The record turns while the song plays.
    const spinGoal = state.playing && !state.loading ? SPIN : 0;
    this.spinRate += (spinGoal - this.spinRate) * follow(2.6, dt);
    if (Math.abs(spinGoal - this.spinRate) < 0.003) this.spinRate = spinGoal;
    if (this.spinRate > 0) {
      this.spin += this.spinRate * dt;
      moving = true;
    }
    this.record.rotation.z = -this.spin;

    // The tonearm: the needle goes with the song, or follows the finger while the arm is dragged.
    const progress = this.drag ? this.drag.progress : state.progress;
    const head = state.song && progress !== null ? armHead(progressToRadius(progress)) : armRest();
    const angleGoal = armAngle(head);
    const armBefore = this.arm;
    this.arm += (angleGoal - this.arm) * follow(this.drag ? 40 : 6, dt);
    if (Math.abs(angleGoal - this.arm) < 0.0004) this.arm = angleGoal;
    const liftGoal = state.song && state.playing && !state.loading && !this.drag ? 0 : state.song && this.drag ? 0.35 : 1;
    const liftBefore = this.lift;
    this.lift += (liftGoal - this.lift) * follow(7, dt);
    if (Math.abs(liftGoal - this.lift) < 0.004) this.lift = liftGoal;
    if (this.arm !== armBefore || this.lift !== liftBefore) moving = true;
    this.armYaw.rotation.z = this.arm;
    this.armPitch.rotation.y = -this.lift * 0.16;

    // The fins.
    if (this.updateFins(state, dt)) moving = true;

    // The lyrics.
    const lyricIndex = state.lyrics?.timed ? state.lyricIndex : -1;
    if (this.lyrics.update(dt, state.positionMs, lyricIndex, time)) moving = true;
    this.lastIndex = lyricIndex;

    // Colours of the backdrop move to the cover's.
    if (this.tintMoving) {
      const k = follow(3.2, dt);
      let settled = true;
      for (const key of ["a", "b", "c"] as const) {
        const now = this.tint[key];
        const goal = this.tintGoal[key];
        now.r += (goal.r - now.r) * k;
        now.g += (goal.g - now.g) * k;
        now.b += (goal.b - now.b) * k;
        if (Math.abs(goal.r - now.r) + Math.abs(goal.g - now.g) + Math.abs(goal.b - now.b) > 0.002) settled = false;
      }
      if (settled) {
        this.tint.a.copy(this.tintGoal.a);
        this.tint.b.copy(this.tintGoal.b);
        this.tint.c.copy(this.tintGoal.c);
        this.tintMoving = false;
      }
      moving = true;
    }
    const uniforms = this.backdropMaterial.uniforms;
    (uniforms.uA.value as THREE.Color).copy(this.tint.a);
    (uniforms.uB.value as THREE.Color).copy(this.tint.b);
    (uniforms.uC.value as THREE.Color).copy(this.tint.c);
    uniforms.uOpacity.value = 1;
    uniforms.uTime.value = time;
    // The whole page fades as one: the canvas itself.
    this.canvas.style.opacity = String(this.appear);

    // The glyph that flashes after a click on the record, and the needle's time label.
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt / 0.7);
      this.flashMesh.visible = this.flash > 0;
      const t = 1 - this.flash;
      const s = this.layout.record.radius * 0.42 * (0.8 + 0.5 * t);
      this.flashMesh.scale.set(s, s, 1);
      (this.flashMesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, this.flash * 1.6) * 0.95;
      this.placeAtRecord(this.flashMesh, 0, 0);
      moving = true;
    }
    this.updateTip(state);

    // The page rises into place as it opens.
    const rise = 1 - this.appear;
    this.turntable.position.x = this.layout.record.cx - this.width / 2 - rise * 90;
    this.lyrics.group.position.x = this.layout.lyrics.x + this.layout.lyrics.width / 2 - this.width / 2 + rise * 60;
    this.headerMesh.position.x = this.layout.header.x + this.layout.header.width / 2 - this.width / 2 + rise * 60;

    if (moving || this.dirty) {
      this.dirty = false;
      this.renderer.clear();
      this.renderer.render(this.backdropScene, this.camera);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Whether the deck is drawing frames of its own (the host keeps the loop going while it is). */
  get animating(): boolean {
    return this.visible;
  }

  /** Print what changed since the last frame: the record's label, the title block, the lyrics. */
  private syncContent(state: DeckState) {
    if (state.coverId !== this.shown.coverId || state.cover !== this.shown.cover) {
      this.shown.coverId = state.coverId;
      this.shown.cover = state.cover;
      this.paintVinyl(state);
      this.colours = state.cover ? this.coloursOf(state.cover) : FALLBACK_COLOURS;
      this.retint();
      this.header.invalidate();
    }
    const songKey = state.song ? `${state.song.title}|${state.song.artists}|${state.song.album}` : "";
    if (songKey !== this.shown.song || state.status !== this.shown.status) {
      this.shown.song = songKey;
      this.shown.status = state.status;
      this.header.invalidate();
    }
    this.paintHeader(state);
    if (state.lyricsId !== this.shown.lyricsId) {
      this.shown.lyricsId = state.lyricsId;
      this.lyrics.setLines(state.lyrics ? state.lyrics.lines : null, state.lyricsNote);
    } else if (!state.lyrics) {
      // Only the note changed (e.g. it went from "loading" to "no lyrics").
      this.lyrics.setLines(null, state.lyricsNote);
    }
  }

  private coloursOf(cover: CanvasImageSource): CoverColours {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 28;
      canvas.height = 28;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(cover, 0, 0, 28, 28);
      return pickColours(ctx.getImageData(0, 0, 28, 28).data);
    } catch {
      // A cover of another origin that the page may not read: the launcher's own colours.
      return FALLBACK_COLOURS;
    }
  }

  private paintVinyl(state: DeckState) {
    this.vinyl.paint(`${state.coverId}|${this.shown.dark}`, (ctx, w) => {
      paintDisc(ctx, w, this.palette, state.cover, !state.song);
    });
    this.vinyl.texture.needsUpdate = true;
  }

  private paintHeader(state: DeckState) {
    const p = this.palette;
    this.header.paint(`${this.shown.song}|${this.shown.status}|${this.shown.coverId}|${this.shown.dark}`, (ctx, w, h) => {
      const tile = 104;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 10, tile, tile, 16);
      ctx.clip();
      if (state.cover) {
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(state.cover, 0, 10, tile, tile);
      } else {
        const fill = ctx.createLinearGradient(0, 10, tile, 10 + tile);
        fill.addColorStop(0, p.accent);
        fill.addColorStop(1, p.accentLow);
        ctx.fillStyle = fill;
        ctx.fillRect(0, 10, tile, tile);
        ctx.fillStyle = p.onAccent;
        ctx.font = `bold 52px ${LYRIC_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("♪", tile / 2, 10 + tile / 2 + 2);
      }
      ctx.restore();
      ctx.strokeStyle = p.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(0.5, 10.5, tile - 1, tile - 1, 16);
      ctx.stroke();

      const x = tile + 22;
      const room = w - x;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = p.muted;
      ctx.font = `12px ${LYRIC_FONT}`;
      ctx.fillText("NOW PLAYING", x, 28);
      if (state.status) {
        const at = x + ctx.measureText("NOW PLAYING").width + 12;
        ctx.font = `bold 13px ${LYRIC_FONT}`;
        ctx.fillStyle = p.accentLow;
        ctx.fillText(state.status, at, 28);
      }
      const title = state.song?.title ?? "还没有播放的歌曲";
      let size = 32;
      ctx.font = `bold ${size}px ${LYRIC_FONT}`;
      while (ctx.measureText(title).width > room && size > 20) {
        size -= 2;
        ctx.font = `bold ${size}px ${LYRIC_FONT}`;
      }
      let shown = title;
      if (ctx.measureText(shown).width > room) {
        while (shown.length > 1 && ctx.measureText(`${shown}…`).width > room) shown = shown.slice(0, -1);
        shown += "…";
      }
      ctx.fillStyle = p.ink;
      ctx.fillText(shown, x, 66);
      const line = (text: string, y: number, px: number, color: string) => {
        ctx.font = `${px}px ${LYRIC_FONT}`;
        let cut = text;
        if (ctx.measureText(cut).width > room) {
          while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
          cut += "…";
        }
        ctx.fillStyle = color;
        ctx.fillText(cut, x, y);
      };
      if (state.song) {
        line(state.song.artists || "—", 92, 18, p.muted);
        if (state.song.album) line(state.song.album, 114, 14, p.muted);
      } else line("在「曲库」里选一张档案开始播放", 92, 18, p.muted);
      void h;
    });
  }

  private updateFins(state: DeckState, dt: number): boolean {
    const spectrum = state.spectrum;
    const active = Boolean(spectrum?.active);
    let moving = active;
    let any = false;
    const beat = spectrum?.beat ?? 0;
    for (let i = 0; i < FIN_COUNT; i++) {
      const wanted = spectrum ? Math.min(1, spectrum.at(finPosition(i)) * (1 + 0.28 * beat)) : 0;
      // The spectrum is already smoothed; this only keeps a fin from snapping when the source changes.
      const level = this.levels[i];
      const next = wanted > level ? level + (wanted - level) * follow(60, dt) : level + (wanted - level) * follow(9, dt);
      const settled = Math.abs(next - wanted) < 0.002 ? wanted : next;
      if (settled !== level) moving = true;
      this.levels[i] = settled;
      if (settled > 0.003) any = true;
    }
    const angleStep = (Math.PI * 2) / FIN_COUNT;
    const width = angleStep * RING_RADIUS * 0.5;
    for (let i = 0; i < FIN_COUNT; i++) {
      const level = this.levels[i];
      const height = FIN_MIN + (FIN_MAX - FIN_MIN) * level;
      const a = finAngle(i);
      this.position.set(Math.sin(a) * RING_RADIUS, -Math.cos(a) * RING_RADIUS, height / 2);
      this.euler.set(0, 0, a);
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(width, 0.1, height);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.fins.setMatrixAt(i, this.matrix);
      this.finColour.copy(this.baseFin).lerp(this.peakFin, Math.min(1, level * 1.25));
      this.fins.setColorAt(i, this.finColour);
    }
    this.fins.instanceMatrix.needsUpdate = true;
    this.fins.instanceColor!.needsUpdate = true;
    void any;
    return moving;
  }

  /** Put a label at a place on the record's plate (record radii), facing the viewer. */
  private placeAtRecord(mesh: THREE.Mesh, x: number, y: number) {
    this.position.set(x, y, 0.08);
    this.turntable.updateWorldMatrix(true, false);
    mesh.position.copy(this.position).applyMatrix4(this.turntable.matrixWorld);
  }

  private updateTip(state: DeckState) {
    if (!this.drag || !state.song || state.durationMs <= 0) {
      this.tipMesh.visible = false;
      return;
    }
    const ms = this.drag.progress * state.durationMs;
    const text = `${clock(ms)} / ${clock(state.durationMs)}`;
    this.tip.paint(`${text}|${this.shown.dark}`, (ctx, w, h) => {
      const p = this.palette;
      ctx.fillStyle = this.shown.dark ? "rgba(10,14,16,0.9)" : "rgba(23,23,19,0.88)";
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `bold 15px ${LYRIC_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, w / 2, h / 2 + 1);
      void p;
    });
    const head = armHead(progressToRadius(this.drag.progress));
    this.placeAtRecord(this.tipMesh, head.x, head.y - 0.28);
    this.tipMesh.position.z += 8;
    this.tipMesh.visible = true;
  }

  // ───────────────────────────────────────────── pointer ─────────────────────────────────────────────

  private aim(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  /** What is under a point of the picture. */
  private target(x: number, y: number): { kind: "head" | "record" | "line"; line: number | null } | null {
    if (!this.active) return null;
    this.aim(x, y);
    this.scene.updateMatrixWorld(true);
    const hasSong = Boolean(this.state?.song);
    if (hasSong && (this.state?.durationMs ?? 0) > 0 && this.raycaster.intersectObject(this.headHit, false).length) return { kind: "head", line: null };
    const line = this.lyrics.pick(this.raycaster);
    const record = this.raycaster.intersectObject(this.recordDisc, false)[0];
    // The record is in front of nothing that matters; a line under the pointer wins only where the record is not.
    if (record) return { kind: "record", line: null };
    if (line !== null && this.state?.lyrics?.timed) return { kind: "line", line };
    return null;
  }

  /** A pointer went down; true when the deck takes the press (it takes every press while it is open, so the stage behind it stays still). */
  down(x: number, y: number): boolean {
    if (!this.active) return false;
    const hit = this.target(x, y);
    this.press = hit ? { kind: hit.kind, line: hit.line, x, y } : null;
    if (hit?.kind === "head") {
      this.drag = { progress: this.state?.progress ?? 0 };
      this.dragTo(x, y);
    }
    return true;
  }

  private dragTo(x: number, y: number) {
    if (!this.drag) return;
    this.aim(x, y);
    this.scene.updateMatrixWorld(true);
    this.inverse.copy(this.turntable.matrixWorld).invert();
    const ray = this.raycaster.ray.clone().applyMatrix4(this.inverse);
    if (ray.intersectPlane(this.plane, this.hitPoint)) this.drag.progress = pointToProgress({ x: this.hitPoint.x, y: this.hitPoint.y });
    this.dirty = true;
  }

  move(x: number, y: number): boolean {
    if (!this.active) return false;
    if (this.drag) {
      this.dragTo(x, y);
      return true;
    }
    const hit = this.target(x, y);
    const kind = hit?.kind ?? null;
    if (kind !== this.hover) {
      this.hover = kind;
      this.dirty = true;
    }
    return kind !== null;
  }

  up(x: number, y: number, cancelled: boolean) {
    const press = this.press;
    this.press = null;
    if (this.drag) {
      const progress = this.drag.progress;
      this.drag = null;
      this.dirty = true;
      if (!cancelled) this.events.seek?.(progress);
      return;
    }
    if (!press || cancelled) return;
    // A click: the press and the release are on the same thing.
    if (Math.hypot(x - press.x, y - press.y) > 10) return;
    const hit = this.target(x, y);
    if (!hit || hit.kind !== press.kind) return;
    if (hit.kind === "record") {
      this.flashPlaying = !this.state?.playing;
      this.flash = 1;
      this.paintFlash();
      this.events.toggle?.();
    } else if (hit.kind === "line" && hit.line !== null) this.events.line?.(hit.line);
  }

  private paintFlash() {
    const playing = this.flashPlaying;
    this.flashPrint.paint(`${playing}`, (ctx, w, h) => {
      ctx.fillStyle = "rgba(10,14,16,0.62)";
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      if (playing) {
        ctx.beginPath();
        ctx.moveTo(w * 0.4, h * 0.3);
        ctx.lineTo(w * 0.72, h * 0.5);
        ctx.lineTo(w * 0.4, h * 0.7);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(w * 0.35, h * 0.3, w * 0.1, h * 0.4);
        ctx.fillRect(w * 0.55, h * 0.3, w * 0.1, h * 0.4);
      }
    });
  }

  leave() {
    if (this.hover !== null) {
      this.hover = null;
      this.dirty = true;
    }
  }

  /** The wheel: over the lyrics it browses the lines, elsewhere it sets the volume. True when handled. */
  wheel(x: number, y: number, deltaY: number): boolean {
    if (!this.active) return false;
    const rect = this.canvas.getBoundingClientRect();
    const px = x - rect.left;
    const inLyrics = px >= this.layout.lyrics.x - 20 && y - rect.top >= this.layout.lyrics.y - 30 && y - rect.top <= this.layout.lyrics.y + this.layout.lyrics.height + 30;
    if (inLyrics && this.state?.lyrics) {
      this.lyrics.scrollBy(deltaY > 0 ? 1 : -1, this.time);
      this.dirty = true;
    } else this.events.volume?.(deltaY > 0 ? -1 : 1);
    return true;
  }

  get cursor(): "pointer" | null {
    return this.hover ? "pointer" : null;
  }

  dispose() {
    this.lyrics.dispose();
    this.vinyl.dispose();
    this.header.dispose();
    this.tip.dispose();
    this.flashPrint.dispose();
    this.shadowTexture.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.fins.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

/** "03:42". */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
