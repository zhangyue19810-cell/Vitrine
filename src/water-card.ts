import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export interface WaterCardTuning {
  width: number;
  height: number;
  depth: number;
  bevel: number;
  segments: number;
  amplitude: number;
  frequency: number;
  speed: number;
  detail: number;
}

export const WATER_CARD_DEFAULTS: WaterCardTuning = {
  width: 9.2,
  height: 6.1,
  depth: 1.25,
  bevel: 0.42,
  segments: 12,
  amplitude: 0.14,
  frequency: 2.1,
  speed: 0.72,
  detail: 0.014,
};

let waterCardTuningHook: ((patch: Partial<WaterCardTuning>) => void) | undefined;
let waterCardTuningState: WaterCardTuning = { ...WATER_CARD_DEFAULTS };

export function getWaterCardTuning(): WaterCardTuning {
  return { ...waterCardTuningState };
}

export function updateWaterCardTuning(patch: Partial<WaterCardTuning>): void {
  waterCardTuningState = { ...waterCardTuningState, ...patch };
  waterCardTuningHook?.(patch);
}

export interface WaterCardState {
  clock: number;
  presence: number;
  morph: number;
  started: boolean;
}

/** A thick, rounded, transparent water slab used as the alternate water body. */
export class WaterCard {
  readonly group = new THREE.Group();
  private geometry!: RoundedBoxGeometry;
  private readonly material: THREE.MeshPhysicalMaterial;
  private basePositions = new Float32Array();
  private baseNormals = new Float32Array();
  private readonly params: WaterCardTuning = { ...waterCardTuningState };
  private mesh!: THREE.Mesh;

  constructor() {
    this.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#f4fbff"),
      metalness: 0,
      roughness: 0.018,
      clearcoat: 1,
      clearcoatRoughness: 0.018,
      transmission: 1,
      thickness: 0.82,
      ior: 1.333,
      attenuationColor: new THREE.Color("#e5f5ff"),
      attenuationDistance: 5.8,
      dispersion: 0.018,
      envMapIntensity: 1.3,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.buildGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => undefined;
    this.group.add(this.mesh);
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    waterCardTuningHook = (patch) => {
      const needsGeometry =
        patch.width !== undefined || patch.height !== undefined || patch.depth !== undefined ||
        patch.bevel !== undefined || patch.segments !== undefined;
      Object.assign(this.params, patch);
      if (needsGeometry) this.buildGeometry();
    };
  }

  private buildGeometry() {
    const p = this.params;
    const previous = this.geometry;
    this.geometry = new RoundedBoxGeometry(
      p.width,
      p.height,
      p.depth,
      Math.max(3, Math.round(p.segments)),
      Math.min(p.bevel, p.depth * 0.46, p.height * 0.18, p.width * 0.18),
    );
    (this.geometry.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (this.geometry.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.basePositions = (this.geometry.attributes.position.array as Float32Array).slice();
    this.baseNormals = (this.geometry.attributes.normal.array as Float32Array).slice();
    if (this.mesh) this.mesh.geometry = this.geometry;
    previous?.dispose();
  }

  place(matrix: THREE.Matrix4) {
    this.group.matrix.copy(matrix);
    this.group.matrixWorldNeedsUpdate = true;
  }

  update(state: WaterCardState) {
    const amount = Math.max(0, Math.min(1, state.presence)) * (1 - Math.min(1, Math.max(0, state.morph)));
    this.material.opacity = 0.84 * amount;
    this.material.transmission = amount > 0.01 ? 1 : 0;
    const p = this.params;
    const position = this.geometry.attributes.position as THREE.BufferAttribute;
    const array = position.array as Float32Array;
    const time = state.clock;
    for (let i = 0; i < array.length; i += 3) {
      const x = this.basePositions[i];
      const y = this.basePositions[i + 1];
      const z = this.basePositions[i + 2];
      const nz = this.baseNormals[i + 2];
      if (Math.abs(nz) < 0.08) {
        array[i] = x;
        array[i + 1] = y;
        array[i + 2] = z;
        continue;
      }
      const wave =
        Math.sin(x * p.frequency * 2.2 - time * p.speed * 1.35) * 0.5 +
        Math.sin((x * 0.72 + y * 0.9) * p.frequency * 1.25 - time * p.speed * 0.82) * 0.28 +
        Math.sin((x - y * 0.55) * p.frequency * 2.6 + time * p.speed * 0.48) * 0.14 +
        Math.sin((x + y) * p.frequency * 9 - time * p.speed * 2.1) * p.detail * 18;
      array[i] = x;
      array[i + 1] = y;
      array[i + 2] = z + Math.sign(nz) * p.amplitude * wave;
    }
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  dispose() {
    waterCardTuningHook = undefined;
    this.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
