import * as THREE from "three";
import { RIPPLE, RIPPLE_GLSL, type RippleSet } from "./ripples";
import type { Eye } from "./cosmos";
import { NOISE_GLSL as NOISE } from "./glsl";

/**
 * The sky behind the cosmos: a nebula and a few thousand stars with a band of them across the picture. The stage's own camera is a long lens (a few degrees of view): through it the real sky would
 * show a handful of stars. So the sky has a lens of its own — a wide one — that follows only part of the camera's turn and
 * drifts slowly by itself; the stars and the nebula are drawn straight in picture coordinates, first (before every solid
 * object), without writing depth, so they never get in the way of a plate. The nebula is baked once into a small texture.
 *
 * The stars use the same wave as the plates (`rippleWave`), measured on the picture: when a ring of water passes, the stars
 * swell and shift a little. (The mouse makes no ripples any more — the set the stage hands over stays empty — so this is dormant;
 * the code stays so that the wave can be given back to the sky.)
 */

const MAX = RIPPLE.max;

/** The sky's own lens: vertical field of view (degrees), how much of the camera's turn it follows, and its own slow drift (rad / s). */
export const SKY_LENS = { fov: 58, follow: 0.32, drift: 0.0032 } as const;

const STAR_VERTEX = /* glsl */ `
uniform mat3 uView;
uniform vec2 uTan;
uniform float uAspect;
uniform float uUnits;
uniform float uTime;
uniform float uScale;
uniform float uMix;
uniform vec2 uShift;
uniform vec4 uRipple[${MAX}];
attribute vec4 aSeed;
varying float vLight;
varying vec3 vColor;
varying float vBig;
${RIPPLE_GLSL}
void main() {
  vec3 v = uView * position;
  if (v.z > -0.05) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vLight = 0.0;
    vColor = vec3(0.0);
    return;
  }
  vec2 ndc = v.xy / (-v.z) / uTan;
  float boost = 0.0;
  vec2 push = vec2(0.0);
  for (int i = 0; i < ${MAX}; i++) {
    float age = uRipple[i].z;
    if (age < 0.0) continue;
    // Distance on the picture, in the world units of the plane the water lies on.
    vec2 r = (ndc - uRipple[i].xy) * vec2(uAspect, 1.0);
    float len = length(r);
    float d = len * uUnits;
    float w = ringWave(d, age) * uRipple[i].w / (1.0 + d * 0.012);
    push += r / max(len, 0.0001) * w;
    boost += w;
  }
  ndc += push * vec2(1.0 / uAspect, 1.0) * 0.05;
  // The camera has moved aside: the stars, far away, move a little with it.
  ndc += uShift;
  gl_Position = vec4(ndc, 0.0, 1.0);
  float twinkle = 0.8 + 0.2 * sin(uTime * (0.5 + aSeed.y * 2.2) + aSeed.z * 6.2831853);
  float lit = max(boost, 0.0);
  gl_PointSize = clamp(aSeed.x * uScale * (1.0 + lit * 1.4), 1.5, 24.0);
  vBig = smoothstep(2.8, 5.2, aSeed.x);
  vLight = (0.5 + 0.14 * aSeed.x) * twinkle * (1.0 + lit * 2.2) * uMix;
  // The palette of the night: bronze, white, violet and cold blue.
  vec3 bronze = vec3(1.0, 0.78, 0.52);
  vec3 violet = vec3(0.78, 0.7, 1.0);
  vec3 cold = vec3(0.68, 0.84, 1.0);
  vec3 white = vec3(1.0, 0.98, 0.95);
  vColor = aSeed.w < 0.3 ? bronze : (aSeed.w < 0.34 ? violet : (aSeed.w < 0.5 ? cold : white));
}`;

const STAR_FRAGMENT = /* glsl */ `
varying float vLight;
varying vec3 vColor;
varying float vBig;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  float d2 = dot(q, q);
  float core = exp(-d2 * 3.2);
  float halo = exp(-sqrt(d2) * 2.6) * 0.28 * vBig;
  // The big stars have a faint cross of light.
  float cross = (exp(-abs(q.x) * 16.0) * exp(-abs(q.y) * 1.8) + exp(-abs(q.y) * 16.0) * exp(-abs(q.x) * 1.8)) * 0.35 * vBig;
  float edge = 1.0 - vBig * smoothstep(0.78, 1.0, length(q));
  gl_FragColor = vec4(vColor, (core + halo + cross) * edge * vLight);
  #include <colorspace_fragment>
}`;

/** A triangle that covers the whole picture; the same vertex shader serves the bake and the nebula pass. */
const SCREEN_VERTEX = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** The clouds, written once into an equirectangular texture (lon → u, lat → v) from the direction of each texel. */
const BAKE_FRAGMENT = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uBand;
uniform vec3 uBandNormal;
varying vec2 vNdc;
${NOISE}
void main() {
  float lon = vNdc.x * 3.14159265;
  float lat = vNdc.y * 1.57079633;
  vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
  float n1 = fbm(d * 2.2);
  float n2 = fbm(d * 3.6 + vec3(7.3, -1.0, 2.1));
  float n3 = fbm(d * 1.5 + vec3(-4.2, 3.3, 0.7));
  vec3 col = uA * smoothstep(0.42, 0.95, n1) * 0.55;
  col += uB * smoothstep(0.45, 0.9, n2) * 0.45;
  col += uC * smoothstep(0.5, 0.95, n3) * 0.35;
  // The band the stars crowd into glows a little, with dust in it.
  float across = dot(d, uBandNormal);
  float band = exp(-(across * across) / (2.0 * 0.16 * 0.16));
  float dust = smoothstep(0.35, 0.9, fbm(d * 5.0 + vec3(3.0, 1.0, 8.0)));
  col += uBand * band * (0.35 + 0.65 * dust);
  gl_FragColor = vec4(col, 1.0);
}`;

const NEBULA_FRAGMENT = /* glsl */ `
uniform sampler2D uSky;
uniform mat3 uSkyOf;
uniform vec2 uTan;
uniform vec2 uShift;
uniform float uMix;
uniform float uGain;
varying vec2 vNdc;
void main() {
  vec3 view = normalize(vec3((vNdc - uShift) * uTan, -1.0));
  vec3 d = uSkyOf * view;
  vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  vec3 col = texture2D(uSky, uv).rgb;
  gl_FragColor = vec4(col * uMix * uGain, 1.0);
  #include <colorspace_fragment>
}`;

export interface SkyFrame {
  time: number;
  /** 0 … 1: how much of the sky is shown. */
  mix: number;
  /** The stage camera's frame (null while the sky is not shown). */
  eye: Eye | null;
  ripples: RippleSet;
  /** How far the sky has moved on the picture (−1 … 1 across; the camera moving aside takes the far sky a little with it). */
  shift?: number;
}

/** The look of the nebula (linear colours) and the band of the stars. */
const CLOUDS = { a: "#2c1d0d", b: "#17120c", c: "#3d2412", band: "#1b140c" } as const;
const BAND_NORMAL = new THREE.Vector3(0.28, 0.86, 0.42).normalize();

const BAKE = { width: 1024, height: 512 };

export class Sky {
  /** The stars and the nebula: drawn in picture coordinates, so they have no place in the world. */
  readonly group = new THREE.Group();
  stars!: THREE.Points;
  readonly starMaterial: THREE.ShaderMaterial;
  private readonly nebula: THREE.Mesh;
  private readonly nebulaMaterial: THREE.ShaderMaterial;
  private readonly basis = new THREE.Matrix4();
  private readonly cameraQuat = new THREE.Quaternion();
  private readonly skyQuat = new THREE.Quaternion();
  private readonly driftQuat = new THREE.Quaternion();
  private readonly driftAxis = new THREE.Vector3(0.3, 1, 0.1).normalize();
  private readonly view = new THREE.Matrix3();
  private readonly skyOf = new THREE.Matrix3();
  private readonly turn = new THREE.Matrix4();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private starCount = 0;
  private target: THREE.WebGLRenderTarget | null = null;
  private baked = false;
  private readonly tan = Math.tan(THREE.MathUtils.degToRad(SKY_LENS.fov) / 2);

  constructor(stars = 9000) {
    this.starMaterial = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uView: { value: this.view },
        uTan: { value: new THREE.Vector2(this.tan, this.tan) },
        uAspect: { value: 1 },
        uUnits: { value: 20 },
        uTime: { value: 0 },
        uScale: { value: 1 },
        uMix: { value: 0 },
        uShift: { value: new THREE.Vector2(0, 0) },
        uRipple: { value: Array.from({ length: MAX }, () => new THREE.Vector4(0, 0, -1, 0)) },
      },
    });
    this.setStars(stars);

    const screen = new THREE.BufferGeometry();
    screen.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.nebulaMaterial = new THREE.ShaderMaterial({
      vertexShader: SCREEN_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSky: { value: null },
        uSkyOf: { value: this.skyOf },
        uTan: { value: new THREE.Vector2(this.tan, this.tan) },
        uShift: { value: new THREE.Vector2(0, 0) },
        uMix: { value: 0 },
        uGain: { value: 1.7 },
      },
    });
    this.nebula = new THREE.Mesh(screen, this.nebulaMaterial);
    this.nebula.frustumCulled = false;
    this.nebula.renderOrder = -300;
    this.nebula.name = "space-nebula";
    this.nebula.userData.excludeFromAO = true;
    this.group.add(this.nebula);

    this.group.visible = false;
  }

  /** Whether the nebula texture has been written (it needs the renderer: see `bake`). */
  get ready() {
    return this.baked;
  }

  /** Scatter `count` stars over the sphere, a share of them in a band across it. */
  setStars(count: number) {
    if (count === this.starCount && this.stars) return;
    this.starCount = count;
    if (this.stars) {
      this.group.remove(this.stars);
      this.stars.geometry.dispose();
    }
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    // A deterministic generator: the sky is the same every time.
    let state = 0x9e3779b9;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-6, random()))) * Math.cos(2 * Math.PI * random());
    const e1 = new THREE.Vector3(1, 0, 0).cross(BAND_NORMAL).normalize();
    const e2 = BAND_NORMAL.clone().cross(e1);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      if (random() < 0.4) {
        const phi = random() * Math.PI * 2;
        const beta = gauss() * 0.16;
        v.copy(e1).multiplyScalar(Math.cos(phi)).addScaledVector(e2, Math.sin(phi)).multiplyScalar(Math.cos(beta)).addScaledVector(BAND_NORMAL, Math.sin(beta));
      } else {
        const z = random() * 2 - 1;
        const phi = random() * Math.PI * 2;
        const s = Math.sqrt(1 - z * z);
        v.set(s * Math.cos(phi), z, s * Math.sin(phi));
      }
      positions.set([v.x, v.y, v.z], i * 3);
      seeds.set([1.5 + 1.3 * random() + 4.2 * Math.pow(random(), 10), random(), random(), random()], i * 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    this.stars = new THREE.Points(geometry, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -200;
    this.stars.name = "space-stars";
    this.stars.userData.excludeFromAO = true;
    this.group.add(this.stars);
  }

  /** The nebula is the costly part of the sky: low tiers leave it out. */
  setNebula(on: boolean) {
    this.nebula.visible = on;
  }

  /** `pixels` is how many device pixels one unit of star size is. */
  setPixelScale(pixels: number) {
    this.starMaterial.uniforms.uScale.value = pixels;
  }

  /** Write the nebula into its texture (one draw of a screen triangle). Safe to call again after the GL context was lost. */
  bake(renderer: THREE.WebGLRenderer) {
    if (this.baked) return;
    this.target ??= new THREE.WebGLRenderTarget(BAKE.width, BAKE.height, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const material = new THREE.ShaderMaterial({
      vertexShader: SCREEN_VERTEX,
      fragmentShader: BAKE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uA: { value: new THREE.Color(CLOUDS.a) },
        uB: { value: new THREE.Color(CLOUDS.b) },
        uC: { value: new THREE.Color(CLOUDS.c) },
        uBand: { value: new THREE.Color(CLOUDS.band) },
        uBandNormal: { value: BAND_NORMAL.clone() },
      },
    });
    const mesh = new THREE.Mesh(this.nebula.geometry, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(this.target);
      renderer.autoClear = true;
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
      material.dispose();
    }
    this.nebulaMaterial.uniforms.uSky.value = this.target.texture;
    this.baked = true;
  }

  /** The texture has to be written again (the GL context came back empty). */
  invalidate() {
    this.baked = false;
    this.nebulaMaterial.uniforms.uSky.value = null;
  }

  /** The point `world` on the picture of `eye`, in −1…1 (y up). */
  private project(eye: Eye, x: number, y: number, z: number, out: { x: number; y: number }) {
    const dx = x - eye.aim[0];
    const dy = y - eye.aim[1];
    const dz = z - eye.aim[2];
    const across = dx * eye.right[0] + dy * eye.right[1] + dz * eye.right[2];
    const up = dx * eye.up[0] + dy * eye.up[1] + dz * eye.up[2];
    const toward = dx * eye.toward[0] + dy * eye.toward[1] + dz * eye.toward[2];
    const depth = Math.max(1, eye.distance - toward);
    out.x = ((across / depth) * eye.distance) / eye.halfWidth;
    out.y = ((up / depth) * eye.distance) / eye.halfHeight;
  }

  private readonly ndc = { x: 0, y: 0 };

  update(frame: SkyFrame) {
    const { time, mix, eye, ripples } = frame;
    const shown = mix > 0.002 && eye !== null;
    this.group.visible = shown;
    if (!shown || !eye) return;

    const aspect = eye.halfWidth / eye.halfHeight;
    // The sky's turn: a part of the camera's, plus a slow drift of its own.
    this.basis.makeBasis(this.tmpA.fromArray(eye.right), this.tmpB.fromArray(eye.up), this.tmpC.fromArray(eye.toward));
    this.cameraQuat.setFromRotationMatrix(this.basis);
    this.skyQuat.identity().slerp(this.cameraQuat, SKY_LENS.follow);
    this.driftQuat.setFromAxisAngle(this.driftAxis, time * SKY_LENS.drift);
    this.skyQuat.multiply(this.driftQuat);
    this.turn.makeRotationFromQuaternion(this.skyQuat.invert());
    this.view.setFromMatrix4(this.turn);
    this.skyOf.copy(this.view).transpose();

    const uniforms = this.starMaterial.uniforms;
    (uniforms.uTan.value as THREE.Vector2).set(this.tan * aspect, this.tan);
    (this.nebulaMaterial.uniforms.uTan.value as THREE.Vector2).set(this.tan * aspect, this.tan);
    uniforms.uAspect.value = aspect;
    uniforms.uUnits.value = eye.halfHeight;
    uniforms.uTime.value = time;
    uniforms.uMix.value = mix;
    const shift = frame.shift ?? 0;
    (uniforms.uShift.value as THREE.Vector2).set(shift, 0);
    (this.nebulaMaterial.uniforms.uShift.value as THREE.Vector2).set(shift, 0);
    this.nebulaMaterial.uniforms.uMix.value = this.baked ? mix : 0;

    const slots = uniforms.uRipple.value as THREE.Vector4[];
    for (let i = 0; i < MAX; i++) {
      const ripple = ripples.items[i];
      if (!ripple) {
        slots[i].set(0, 0, -1, 0);
        continue;
      }
      this.project(eye, ripple.x, ripple.y, ripple.z, this.ndc);
      slots[i].set(this.ndc.x, this.ndc.y, ripple.age, ripple.power);
    }
  }

  dispose() {
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    this.nebula.geometry.dispose();
    this.nebulaMaterial.dispose();
    this.target?.dispose();
  }
}
