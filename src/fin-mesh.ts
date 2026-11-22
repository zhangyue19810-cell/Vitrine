import * as THREE from "three";
import { BAND, BOUNCE, BandPath, TRACK, newPlate, plateAt, staggered, trackPlateAt, unrollOrder, type PlateFrame } from "./fin-band";
import type { SpectrumField } from "./spectrum";
import { cosmosPlate, hash as cosmosHash, newPlaced, type Eye, type KeepOut, type Placed } from "./space/cosmos";
import { haloBand, haloPlate, haloSlot, type Halo } from "./space/halo";
import type { RippleSet } from "./space/ripples";
import { BANDS, bandOf, ringPlate, type System } from "./space/disk";

/**
 * The plates of the Möbius ring as ONE instanced mesh (a single draw call, and a single shadow caster). The mesh knows
 * nothing about archives: it is told how far the ring has turned, how far the picture has morphed from the ring into the
 * download track, and how much of the band has assembled, and it lays every plate out from that (see `fin-band.ts`).
 */

export interface FinState {
  /** Lap fractions the ring has turned by: the plates travel along the band with the archives. */
  turn: number;
  /** The same for the track: plates slide along it as the row scrolls. */
  shift: number;
  /** 0 = the Möbius ring, 1 = the flat track. */
  morph: number;
  /** Seconds; drives the slow undulation. */
  clock: number;
  /** 0 … 1: the band assembling from below (first appearance) or leaving. */
  presence: number;
  /** The music, while it plays: every plate jumps with the band that lies under it (bass at the focus, treble at the far end). */
  audio?: SpectrumField | null;
  /** Seconds since the last update (smooths the levels of the halo's plates). */
  dt?: number;
  /** A world the plates leave the ring / track for (deep space, or the rings round the record). */
  world?: WorldState | null;
}

export interface WorldState {
  /** 0 … 1: how far the plates have left the ring / track for the world. */
  mix: number;
  /** 0 … 1: how far the world has become the record's page (most plates in rings round the record, the rest floating). */
  deck: number;
  /** Seconds; runs on whenever the world is on screen (the ring's own clock stops when the picture is not the ring). */
  time: number;
  eye: Eye;
  /** Parts of the picture the floating plates stay clear of. */
  keep: readonly KeepOut[];
  /** The water the pointer stirs. */
  ripples: RippleSet | null;
  halo: Halo | null;
  /** The black hole and its disk, while the world is the music page's: most plates are debris of the disk then. */
  system: System | null;
}

const TAU = Math.PI * 2;
const fract = (value: number) => value - Math.floor(value);
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

/** What the plates are tinted towards when they hear something (multiplies the glaze: gold in either theme). */
const GLOW: [number, number, number] = [1.75, 1.3, 0.62];

/** The colour of the debris in deep space, whichever theme the rest of the picture is in: pale gold dust. */
const ICE = new THREE.Color("#cdbb94");

/** Stops of the disk's colour by heat (0 cool … 1.6 white-hot): what a plate's glaze is multiplied by. */
const HEAT: readonly (readonly [number, number, number, number])[] = [
  [0, 0.38, 0.2, 0.08],
  [0.5, 0.95, 0.55, 0.22],
  [1, 1.55, 1.1, 0.6],
  [1.6, 1.9, 1.7, 1.35],
];

/** The multiplier for the colour of a plate at `heat`, written into `out`. */
function heatTint(heat: number, out: [number, number, number]) {
  let k = 0;
  while (k < HEAT.length - 2 && heat > HEAT[k + 1][0]) k++;
  const a = HEAT[k];
  const b = HEAT[k + 1];
  const t = THREE.MathUtils.clamp((heat - a[0]) / (b[0] - a[0]), 0, 1);
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
  out[2] = a[3] + (b[3] - a[3]) * t;
}

/** Where the plate that rests at the focus lies on the track: slot 0, the pulled-out card's place. */
const TRACK_ORIGIN = (0 - TRACK.from) / (TRACK.to - TRACK.from);

/** A rounded plate, wide × tall × thin along x, y, z, with softly bevelled edges. */
function plateGeometry(): THREE.BufferGeometry {
  const { width, height, thickness } = BAND.plate;
  const radius = Math.min(width, height) * 0.1;
  const hw = width / 2;
  const hh = height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw + radius, -hh);
  shape.lineTo(hw - radius, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + radius);
  shape.lineTo(hw, hh - radius);
  shape.quadraticCurveTo(hw, hh, hw - radius, hh);
  shape.lineTo(-hw + radius, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - radius);
  shape.lineTo(-hw, -hh + radius);
  shape.quadraticCurveTo(-hw, -hh, -hw + radius, -hh);
  const bevel = Math.min(0.045, thickness * 0.2);
  const depth = thickness - 2 * bevel;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4, steps: 1 });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

/** Cheap deterministic number in [0, 1) for plate `i` (and salt). */
const hash = (i: number, salt = 0) => fract(Math.sin(i * 127.1 + salt * 311.7 + 17.3) * 43758.5453);

/** A plate's place and size, for flying it from one formation to another. */
class Pose3 {
  readonly pos = new THREE.Vector3();
  readonly q = new THREE.Quaternion();
  w = 0;
  h = 0;
  t = 0;
}

export class FinMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshPhysicalMaterial;
  private readonly path = new BandPath();
  private readonly count: number;
  private readonly light = new THREE.Color("#f3eee5");
  private readonly dark = new THREE.Color("#54493a");
  private signature = "";
  /** The plates' own tints (the music tints them for a moment; they go back to these). */
  private readonly baseColors: Float32Array;
  private tinted = false;
  private amount = 0;
  private deep = 0;
  /** How loud each halo plate is (smoothed, so a plate does not snap when the spectrum does). */
  private readonly levels: Float32Array;
  private readonly placed = newPlaced();
  private readonly placed2 = newPlaced();
  private readonly hot: [number, number, number] = [1, 1, 1];
  private readonly c: PlateFrame = newPlate();
  /** The poses a plate is flown between: where the ring has put it, and where the world wants it. */
  private readonly current = new Pose3();
  private readonly target = new Pose3();
  private readonly goal = new Pose3();

  private readonly a: PlateFrame = newPlate();
  private readonly b: PlateFrame = newPlate();
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly basis = new THREE.Matrix4();
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();
  private readonly qt = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();

  constructor(count: number = BAND.count) {
    this.count = count;
    this.material = new THREE.MeshPhysicalMaterial({
      color: this.light.clone(),
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.45,
      envMapIntensity: 0.9,
      iridescence: 0.001,
      iridescenceIOR: 1.8,
      iridescenceThicknessRange: [180, 520],
    });
    this.mesh = new THREE.InstancedMesh(plateGeometry(), this.material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = "archive-fins";
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      // A little variation from plate to plate: a warm or cool cast and a touch of lightness, like glazed ceramic.
      const lightness = 0.955 + 0.045 * hash(i, 1);
      const warm = (hash(i, 2) - 0.5) * 0.035;
      tint.setRGB(lightness + warm, lightness + warm * 0.4, lightness - warm);
      this.mesh.setColorAt(i, tint);
    }
    this.baseColors = Float32Array.from(this.mesh.instanceColor!.array);
    this.levels = new Float32Array(count);
  }

  get plates() {
    return this.count;
  }

  /** 0 (light) … 1 (dark). */
  setTheme(amount: number) {
    this.amount = THREE.MathUtils.clamp(amount, 0, 1);
    this.paintMaterial();
  }

  /** 0 … 1: how far the plates are the ice of deep space (they stay light there, in either theme). */
  setDeep(deep: number) {
    deep = THREE.MathUtils.clamp(deep, 0, 1);
    if (Math.abs(deep - this.deep) < 0.002) return;
    this.deep = deep;
    this.paintMaterial();
  }

  private paintMaterial() {
    const m = this.material;
    m.color.copy(this.light).lerp(this.dark, this.amount).lerp(ICE, this.deep);
    // A little light of their own, so the side the sun does not reach is not a hole in the picture.
    m.emissive.copy(ICE).multiplyScalar(0.03 * this.deep);
    // In deep space the plates are debris of burnished metal under a clear coat with a thin film of colour on it: they glint where the
    // light of the disk meets them. (Iridescence has a tiny share even at rest: a share of zero would be another shader.)
    const d = this.deep;
    m.metalness = 0.9 * d;
    m.roughness = THREE.MathUtils.lerp(0.5, 0.3, d);
    m.clearcoat = THREE.MathUtils.lerp(0.12, 1, d);
    m.clearcoatRoughness = THREE.MathUtils.lerp(0.45, 0.1, d);
    m.iridescence = 0.001 + 0.45 * d;
    m.envMapIntensity = THREE.MathUtils.lerp(0.9, 2.3, d);
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible;
  }

  /** Lay the plates out for `state`. Returns true when the matrices were rewritten (so the frame must be redrawn). */
  update(state: FinState): boolean {
    const audio = state.audio && state.audio.active ? state.audio : null;
    const world = state.world && state.world.mix > 0.0005 ? state.world : null;
    const key = `${state.turn.toFixed(5)}|${state.shift.toFixed(5)}|${state.morph.toFixed(4)}|${state.clock.toFixed(3)}|${state.presence.toFixed(4)}|${audio ? audio.version : 0}`;
    // A world is alive every frame (things drift, the water moves); the ring and the track only when something changed.
    if (!world && key === this.signature) return false;
    this.signature = world ? "" : key;
    const colors = this.mesh.instanceColor?.array as Float32Array | undefined;
    const dt = Math.max(0, Math.min(0.25, state.dt ?? 1 / 60));
    const rise = 1 - Math.exp(-60 * dt);
    const fall = 1 - Math.exp(-9 * dt);
    // While there is something that can tint a plate, every plate's colour is written each time; otherwise they are left alone.
    const painting = Boolean(colors) && (Boolean(audio) || Boolean(world) || this.tinted);
    let anyTint = false;
    const { a, b, c, matrix, basis, qa, qb, qt, pos, scale, dir, side, up, placed, placed2 } = this;
    const ringSize = BAND.plate;
    const morph = THREE.MathUtils.clamp(state.morph, 0, 1);
    const presence = THREE.MathUtils.clamp(state.presence, 0, 1);
    for (let i = 0; i < this.count; i++) {
      const base = i / this.count;
      const lap = fract(base + BAND.focus - state.turn);
      const order = unrollOrder(lap);
      const e = staggered(morph, order);
      const assembled = smooth(presence * 1.45 - 0.45 * order);
      if (assembled <= 0.001) {
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }

      plateAt(this.path, lap, state.clock, a);
      let width = ringSize.width;
      let height = ringSize.height;
      let thickness = ringSize.thickness;
      pos.set(a.p[0], a.p[1], a.p[2]);
      basis.makeBasis(this.axisX.set(a.x[0], a.x[1], a.x[2]), this.axisY.set(a.y[0], a.y[1], a.y[2]), this.axisZ.set(a.z[0], a.z[1], a.z[2]));
      qa.setFromRotationMatrix(basis);
      let fade = 1;
      let x = order;

      if (e > 0.0005) {
        const u = fract(base + TRACK_ORIGIN - state.shift);
        trackPlateAt(u, b);
        basis.makeBasis(this.axisX.set(b.x[0], b.x[1], b.x[2]), this.axisY.set(b.y[0], b.y[1], b.y[2]), this.axisZ.set(b.z[0], b.z[1], b.z[2]));
        qb.setFromRotationMatrix(basis);
        dir.set(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
        const distance = dir.length();
        pos.x += (b.p[0] - a.p[0]) * e;
        pos.y += (b.p[1] - a.p[1]) * e;
        pos.z += (b.p[2] - a.p[2]) * e;
        qa.slerp(qb, e);
        if (distance > 1e-4 && e < 0.9995) {
          dir.multiplyScalar(1 / distance);
          // Each plate travels on its own helix around the straight line to its place, and tumbles a little on the way.
          side.set(0, 1, 0).cross(dir);
          if (side.lengthSq() < 1e-4) side.set(1, 0, 0).cross(dir);
          side.normalize();
          up.copy(dir).cross(side);
          const swing = Math.sin(Math.PI * e) * Math.min(5.5, 0.2 * distance);
          const theta = hash(i, 3) * TAU + e * 4.6;
          pos.addScaledVector(side, Math.cos(theta) * swing).addScaledVector(up, Math.sin(theta) * swing);
          qt.setFromAxisAngle(dir, Math.sin(Math.PI * e) * (hash(i, 4) - 0.5) * 1.6);
          qa.premultiply(qt);
        }
        width += (TRACK.plate.width - width) * e;
        height += (TRACK.plate.height - height) * e;
        thickness += (TRACK.plate.thickness - thickness) * e;
        // The track's two ends are where plates wrap round the strip: they shrink there instead of popping.
        const endFade = smooth(u / 0.04) * smooth((1 - u) / 0.04);
        fade = 1 + (endFade - 1) * e;
        // On the track the plates listen by their place along it: bass under the selected archive's end, treble far along.
        x += (u - x) * e;
      }

      // The world: the plates fly on from where the ring (or the track) has put them to their place in space.
      let tint = 0;
      let ew = 0;
      let tone = 1;
      let heat = 0;
      if (world) {
        ew = staggered(THREE.MathUtils.clamp(world.mix, 0, 1), order);
        if (ew > 0.0005) {
          const system = world.system;
          const band = system ? bandOf(i) : -1;
          const ringed = system !== null && band >= 0;
          // Where it listens to the music from: its place across the rings, or a band of its own out in the open.
          let listen = cosmosHash(i, 30);
          if (system && ringed) {
            // … a piece of the disk of the music page …
            listen = ringPlate(i, world.time, system, world.ripples, b, placed);
            tone = BANDS[band].tone;
            heat = placed.heat ?? 0;
          } else {
            // … or a wanderer in the open cosmos.
            cosmosPlate(i, world.time, world.eye, world.keep, world.ripples, b, placed);
            heat = 0.4 + 0.5 * cosmosHash(i, 31);
            // Beside the disk the wanderers are small: a few bright specks, not paper in the air.
            if (system) {
              placed.width *= 0.5;
              placed.height *= 0.5;
            }
          }
          if (audio) {
            const twinkle = audio.at(listen);
            placed.glow = Math.max(placed.glow, twinkle * 0.5);
            const swell = 1 + 0.09 * twinkle;
            placed.width *= swell;
            placed.height *= swell;
          }
          const target = this.target;
          this.load(target, b, placed);
          let targetGlow = placed.glow;
          const ed = staggered(THREE.MathUtils.clamp(world.deck, 0, 1), order);
          // When the page becomes the record's, the grains leave the rings for the open cosmos …
          if (ringed && world.deck > 0.0005) {
            cosmosPlate(i, world.time, world.eye, world.keep, world.ripples, c, placed2);
            this.fly(target, target, c, placed2, ed, i, 11);
            targetGlow += (placed2.glow - targetGlow) * ed;
          }
          // … and the plates that stand in rings round the record fly to their place there as the page opens.
          const slot = world.halo && world.deck > 0.0005 ? haloSlot(i, this.count) : -1;
          if (slot >= 0 && world.halo) {
            const wanted = audio ? Math.min(1, audio.at(haloBand(slot)) * (1 + 0.28 * audio.beat)) : 0;
            const level = this.levels[i];
            const next = level + (wanted - level) * (wanted > level ? rise : fall);
            this.levels[i] = Math.abs(next - wanted) < 0.002 ? wanted : next;
            haloPlate(slot, world.halo, this.levels[i], world.time, c, placed2);
            this.fly(target, target, c, placed2, ed, i, 7);
            targetGlow += (placed2.glow - targetGlow) * ed;
          }
          this.current.pos.copy(pos);
          this.current.q.copy(qa);
          this.current.w = width;
          this.current.h = height;
          this.current.t = thickness;
          this.fly(this.current, this.current, null, null, ew, i, 5, target);
          pos.copy(this.current.pos);
          qa.copy(this.current.q);
          width = this.current.w;
          height = this.current.h;
          thickness = this.current.t;
          fade += (1 - fade) * ew;
          tint = targetGlow * ew * 0.8;
        }
      }

      if (audio && ew < 0.999) {
        const heard = audio.at(x) * assembled * (1 - ew);
        if (heard > 0.002) {
          pos.y += heard * BOUNCE.lift;
          width *= 1 + heard * BOUNCE.wide;
          height *= 1 + heard * BOUNCE.tall;
          tint = Math.max(tint, heard * BOUNCE.glow);
        }
      }
      if (painting && colors) {
        const at = i * 3;
        // Each band of the rings has its own brightness, as far as the plate has got there.
        const level = 1 + (tone - 1) * ew;
        if (Math.abs(level - 1) > 0.002) anyTint = true;
        // … and its own colour of the disk's heat, as far as the plate has got there.
        const hot = this.hot;
        if (ew > 0.002) {
          heatTint(heat, hot);
          anyTint = true;
        }
        for (let channel = 0; channel < 3; channel++) {
          const base = this.baseColors[at + channel] * level * (ew > 0.002 ? 1 + (hot[channel] - 1) * ew : 1);
          colors[at + channel] = tint > 0.002 ? base + (GLOW[channel] - base) * Math.min(1, tint) : base;
        }
        if (tint > 0.002) anyTint = true;
      }

      if (assembled < 0.999) pos.y -= (1 - assembled) * 14;
      const grow = fade * assembled;
      scale.set((width / ringSize.width) * grow, (height / ringSize.height) * grow, (thickness / ringSize.thickness) * grow);
      matrix.compose(pos, qa, scale);
      this.mesh.setMatrixAt(i, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (painting) {
      this.mesh.instanceColor!.needsUpdate = true;
      this.tinted = anyTint;
    }
    return true;
  }

  /** Set `pose` to a plate frame and its size. */
  private load(pose: Pose3, frame: PlateFrame, placed: Placed) {
    pose.pos.set(frame.p[0], frame.p[1], frame.p[2]);
    this.basis.makeBasis(this.axisX.set(frame.x[0], frame.x[1], frame.x[2]), this.axisY.set(frame.y[0], frame.y[1], frame.y[2]), this.axisZ.set(frame.z[0], frame.z[1], frame.z[2]));
    pose.q.setFromRotationMatrix(this.basis);
    pose.w = placed.width;
    pose.h = placed.height;
    pose.t = placed.thickness;
  }

  /**
   * Fly `from` to a place by `e` (0 … 1) of the way, writing the result into `out` (which may be `from`). The place is a plate
   * frame (`frame`, `placed`) or, when `frame` is null, the pose `to`. Each plate goes on its own helix round the straight line to
   * its place and tumbles a little on the way; `salt` keeps the helix of one flight from being the helix of another.
   */
  private fly(from: Pose3, out: Pose3, frame: PlateFrame | null, placed: Placed | null, e: number, i: number, salt: number, to: Pose3 = this.target) {
    const { qb, qt, dir, side, up } = this;
    if (frame && placed) {
      this.load(this.goal, frame, placed);
      to = this.goal;
    }
    qb.copy(to.q);
    dir.copy(to.pos).sub(from.pos);
    const distance = dir.length();
    out.pos.copy(from.pos).addScaledVector(dir, e);
    out.q.copy(from.q).slerp(qb, e);
    if (distance > 1e-4 && e < 0.9995 && e > 0.0005) {
      dir.multiplyScalar(1 / distance);
      side.set(0, 1, 0).cross(dir);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0).cross(dir);
      side.normalize();
      up.copy(dir).cross(side);
      const swing = Math.sin(Math.PI * e) * Math.min(6.5, 0.2 * distance);
      const theta = hash(i, salt) * TAU + e * 4.2;
      out.pos.addScaledVector(side, Math.cos(theta) * swing).addScaledVector(up, Math.sin(theta) * swing);
      qt.setFromAxisAngle(dir, Math.sin(Math.PI * e) * (hash(i, salt + 1) - 0.5) * 2.2);
      out.q.premultiply(qt);
    }
    out.w = from.w + (to.w - from.w) * e;
    out.h = from.h + (to.h - from.h) * e;
    out.t = from.t + (to.t - from.t) * e;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
