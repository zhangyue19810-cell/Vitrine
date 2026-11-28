import * as THREE from "three";
import { BAND, BandPath, newPlate, plateAt } from "./fin-band";

export interface WaterRingTuning {
  widthScale: number;
  waveAmplitude: number;
  waveFrequency: number;
  waveSpeed: number;
  flowScale: number;
  turbulence: number;
  opacity: number;
  transmission: number;
  ior: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  dispersion: number;
  attenuationDistance: number;
  envMapIntensity: number;
  bumpScale: number;
  color: string;
  attenuation: string;
}

export const WATER_RING_DEFAULTS: WaterRingTuning = {
  widthScale: 1.35,
  waveAmplitude: 0.16,
  waveFrequency: 7,
  waveSpeed: 3,
  flowScale: 3,
  turbulence: 0.018,
  opacity: 0.82,
  transmission: 1,
  ior: 1.333,
  roughness: 0.018,
  clearcoat: 1,
  clearcoatRoughness: 0.018,
  dispersion: 0.018,
  attenuationDistance: 5.8,
  envMapIntensity: 1.3,
  bumpScale: 0.018,
  color: "#f4fbff",
  attenuation: "#e5f5ff",
};

let waterTuningHook: ((patch: Partial<WaterRingTuning>) => void) | undefined;
let waterTuningState: WaterRingTuning = { ...WATER_RING_DEFAULTS };

export function getWaterRingTuning(): WaterRingTuning {
  return { ...waterTuningState };
}

export function updateWaterRingTuning(patch: Partial<WaterRingTuning>): void {
  waterTuningState = { ...waterTuningState, ...patch };
  waterTuningHook?.(patch);
}

export interface WaterMobiusState {
  clock: number;
  presence: number;
  morph: number;
  started: boolean;
}

/**
 * The liquid Möbius alternative to the archive fin band. It samples the same
 * figure-eight centre line as the ring, but builds one continuous water ribbon
 * instead of hundreds of plates.
 */
export class WaterMobiusRing {
  readonly group = new THREE.Group();
  private mesh!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  private geometry!: THREE.BufferGeometry;
  private readonly material: THREE.MeshPhysicalMaterial;
  private readonly params: WaterRingTuning = { ...waterTuningState };
  private readonly bumpTexture: THREE.CanvasTexture;
  private shader?: {
    uniforms: {
      uTime: { value: number };
      uWave: { value: number };
      uSpeed: { value: number };
      uFrequency: { value: number };
      uFlowScale: { value: number };
      uTurbulence: { value: number };
    };
  };

  constructor() {
    const bumpCanvas = document.createElement("canvas");
    bumpCanvas.width = bumpCanvas.height = 256;
    const bumpContext = bumpCanvas.getContext("2d")!;
    const image = bumpContext.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const u = x / 256;
        const v = y / 256;
        const wave =
          Math.sin((u * 17 + Math.sin(v * 11) * 0.32) * Math.PI * 2) * 0.31 +
          Math.sin((v * 29 - u * 7) * Math.PI * 2) * 0.19 +
          Math.sin((u * 43 + v * 37) * Math.PI * 2) * 0.08;
        const value = Math.max(0, Math.min(255, 128 + wave * 127));
        const offset = (y * 256 + x) * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = value;
        image.data[offset + 3] = 255;
      }
    }
    bumpContext.putImageData(image, 0, 0);
    this.bumpTexture = new THREE.CanvasTexture(bumpCanvas);
    this.bumpTexture.wrapS = this.bumpTexture.wrapT = THREE.RepeatWrapping;
    this.bumpTexture.repeat.set(5, 3);
    this.bumpTexture.colorSpace = THREE.NoColorSpace;
    this.bumpTexture.needsUpdate = true;

    this.material = new THREE.MeshPhysicalMaterial({
      bumpMap: this.bumpTexture,
      bumpScale: this.params.bumpScale,
      sheen: 0.32,
      sheenColor: new THREE.Color("#e9fcff"),
      sheenRoughness: 0.35,
      iridescence: 0.08,
      iridescenceIOR: 1.3,
      color: new THREE.Color(this.params.color),
      metalness: 0,
      roughness: this.params.roughness,
      dispersion: this.params.dispersion,
      clearcoat: 1,
      clearcoatRoughness: this.params.clearcoatRoughness,
      transmission: this.params.transmission,
      thickness: 0.82,
      ior: this.params.ior,
      attenuationColor: new THREE.Color(this.params.attenuation),
      attenuationDistance: this.params.attenuationDistance,
      envMapIntensity: this.params.envMapIntensity,
      transparent: true,
      opacity: this.params.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uWave = { value: this.params.waveAmplitude };
      shader.uniforms.uSpeed = { value: this.params.waveSpeed };
      shader.uniforms.uFrequency = { value: this.params.waveFrequency };
      shader.uniforms.uFlowScale = { value: this.params.flowScale };
      shader.uniforms.uTurbulence = { value: this.params.turbulence };
      shader.vertexShader = `uniform float uTime;\nuniform float uWave;\nuniform float uSpeed;\nuniform float uFrequency;\nuniform float uFlowScale;\nuniform float uTurbulence;\n${shader.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float waterWave = sin(position.x * 0.72 + position.y * 0.48 + uTime * uSpeed) * uWave;
        waterWave += sin(position.z * 1.4 - uTime * uSpeed * 0.62) * uWave * 0.52;
        transformed += normal * waterWave;`,
      );
      this.shader = shader as unknown as typeof this.shader;
    };
    this.material.customProgramCacheKey = () => "vitrine-water-mobius-v2";

    this.buildGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.visible = true;
    this.mesh.raycast = () => undefined;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.group.add(this.mesh);
    this.group.visible = false;

    waterTuningHook = (patch) => {
      const widthChanged = patch.widthScale !== undefined && patch.widthScale !== this.params.widthScale;
      Object.assign(this.params, patch);
      if (widthChanged) this.buildGeometry();
      this.applyMaterial();
    };
  }

  private buildGeometry() {
    const path = new BandPath();
    const plate = newPlate();
    const rings = 360;
    const across = 10;
    const halfWidth = BAND.plate.width * 0.62 * Math.max(0.35, Math.min(1.6, this.params.widthScale));
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let i = 0; i <= rings; i++) {
      const lap = i / rings;
      plateAt(path, lap, 0, plate);
      for (let j = 0; j <= across; j++) {
        const v = (j / across) * 2 - 1;
        positions.push(
          plate.p[0] + plate.x[0] * v * halfWidth,
          plate.p[1] + plate.x[1] * v * halfWidth,
          plate.p[2] + plate.x[2] * v * halfWidth,
        );
        uvs.push(lap, j / across);
      }
    }
    const indices: number[] = [];
    const row = across + 1;
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < across; j++) {
        const a = i * row + j;
        const b = a + row;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    next.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    next.setIndex(indices);
    next.computeVertexNormals();
    const previous = this.geometry;
    this.geometry = next;
    if (this.mesh) this.mesh.geometry = next;
    previous?.dispose();
  }

  private applyMaterial() {
    this.material.color.set(this.params.color);
    this.material.opacity = this.params.opacity;
    this.material.transmission = this.params.transmission;
    this.material.ior = this.params.ior;
    this.material.roughness = this.params.roughness;
    this.material.clearcoat = this.params.clearcoat;
    this.material.clearcoatRoughness = this.params.clearcoatRoughness;
    this.material.dispersion = this.params.dispersion;
    this.material.attenuationColor.set(this.params.attenuation);
    this.material.attenuationDistance = this.params.attenuationDistance;
    this.material.envMapIntensity = this.params.envMapIntensity;
    this.material.bumpScale = this.params.bumpScale;
    this.material.needsUpdate = true;
    if (this.shader) {
      this.shader.uniforms.uWave.value = this.params.waveAmplitude;
      this.shader.uniforms.uSpeed.value = this.params.waveSpeed;
      this.shader.uniforms.uFrequency.value = this.params.waveFrequency;
      this.shader.uniforms.uFlowScale.value = this.params.flowScale;
      this.shader.uniforms.uTurbulence.value = this.params.turbulence;
    }
  }

  update(state: WaterMobiusState) {
    const amount = Math.max(0, Math.min(1, state.presence)) * (1 - Math.min(1, Math.max(0, state.morph)));
    this.group.visible = state.started && amount > 0.002;
    this.material.opacity = this.params.opacity * amount;
    this.material.transmission = amount > 0.01 ? this.params.transmission : 0;
    if (this.shader) {
      this.shader.uniforms.uTime.value = state.clock;
      this.shader.uniforms.uWave.value = this.params.waveAmplitude;
      this.shader.uniforms.uSpeed.value = this.params.waveSpeed;
      this.shader.uniforms.uFrequency.value = this.params.waveFrequency;
      this.shader.uniforms.uFlowScale.value = this.params.flowScale;
      this.shader.uniforms.uTurbulence.value = this.params.turbulence;
    }
    this.group.rotation.z = Math.sin(state.clock * 0.075) * 0.045;
  }

  dispose() {
    waterTuningHook = undefined;
    this.geometry.dispose();
    this.bumpTexture.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
