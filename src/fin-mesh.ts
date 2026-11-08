import * as THREE from "three";
import { BAND, BandPath, TRACK, newPlate, plateAt, staggered, trackPlateAt, unrollOrder, type PlateFrame } from "./fin-band";

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
}

const TAU = Math.PI * 2;
const fract = (value: number) => value - Math.floor(value);
const smooth = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

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

export class FinMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshPhysicalMaterial;
  private readonly path = new BandPath();
  private readonly count: number;
  private readonly light = new THREE.Color("#f3eee5");
  private readonly dark = new THREE.Color("#3b4348");
  private signature = "";

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
  }

  get plates() {
    return this.count;
  }

  /** 0 (light) … 1 (dark). */
  setTheme(amount: number) {
    this.material.color.copy(this.light).lerp(this.dark, THREE.MathUtils.clamp(amount, 0, 1));
  }

  setVisible(visible: boolean) {
    this.mesh.visible = visible;
  }

  /** Lay the plates out for `state`. Returns true when the matrices were rewritten (so the frame must be redrawn). */
  update(state: FinState): boolean {
    const key = `${state.turn.toFixed(5)}|${state.shift.toFixed(5)}|${state.morph.toFixed(4)}|${state.clock.toFixed(3)}|${state.presence.toFixed(4)}`;
    if (key === this.signature) return false;
    this.signature = key;
    const { a, b, matrix, basis, qa, qb, qt, pos, scale, dir, side, up } = this;
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
      }

      if (assembled < 0.999) pos.y -= (1 - assembled) * 14;
      const grow = fade * assembled;
      scale.set((width / ringSize.width) * grow, (height / ringSize.height) * grow, (thickness / ringSize.thickness) * grow);
      matrix.compose(pos, qa, scale);
      this.mesh.setMatrixAt(i, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
