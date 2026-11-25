import * as THREE from "three";
import { glassRevealGLSL, frostedTransmissionGLSL, FROSTED_ROUGHNESS } from "./glass-reveal.ts";
import { internalOpticsFragment } from "./internal-optics.ts";
import { themeMaterial } from "./theme-material";
import type { RingMaterialPreset } from "./ring-materials";

type Surface = THREE.MeshPhysicalMaterial;
type Palette = { high: Surface; low?: Surface };

interface SurfaceSnapshot {
  color: THREE.Color;
  metalness: number;
  roughness: number;
  transmission?: number;
  thickness?: number;
  attenuationColor?: THREE.Color;
  attenuationDistance?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  envMapIntensity: number;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
}

// The array and selected file share geometry. Morph their surface properties
// on one mesh so transparent shells never overlap during a quality change.
export class CardAppearance {
  private palettes = new Map<string, Palette>();
  private readonly tracked = new Map<Surface, { name: string; base: SurfaceSnapshot }>();
  private materialStyle?: RingMaterialPreset;

  disposeSources() {
    for (const palette of this.palettes.values()) { palette.high.dispose(); palette.low?.dispose(); }
    this.palettes.clear();
    this.tracked.clear();
  }

  register(name: string, high: Surface, low?: Surface) {
    this.palettes.set(name, { high, low });
    this.track(high, name);
    if (low) this.track(low, name);
  }

  /** Adopt a runtime material created by a quality tier (e.g. its fast clone). */
  trackSurface(material: Surface, name: string) {
    this.track(material, name);
  }

  /** Set the PBR look of the ring. Original black-gold restores the studio materials. */
  setRingMaterial(preset: RingMaterialPreset) {
    this.materialStyle = preset;
    for (const [material, entry] of this.tracked) {
      this.restore(material, entry.base);
      if (!preset.original) this.style(material, entry.name, 1);
      material.needsUpdate = true;
    }
  }

  /** Clone a palette source at its original PBR values, then reapply the active preset. */
  private cloneSource(material: Surface): Surface {
    const clone = material.clone();
    const baseline = this.tracked.get(material)?.base;
    if (baseline) this.restore(clone, baseline);
    return clone;
  }

  private snapshot(material: Surface): SurfaceSnapshot {
    return {
      color: material.color.clone(),
      metalness: material.metalness,
      roughness: material.roughness,
      transmission: material.transmission,
      thickness: material.thickness,
      attenuationColor: material.attenuationColor?.clone(),
      attenuationDistance: material.attenuationDistance,
      clearcoat: material.clearcoat,
      clearcoatRoughness: material.clearcoatRoughness,
      envMapIntensity: material.envMapIntensity,
      emissive: material.emissive?.clone(),
      emissiveIntensity: material.emissiveIntensity,
    };
  }

  private track(material: Surface, name: string) {
    if (this.tracked.has(material)) return;
    this.tracked.set(material, { name, base: this.snapshot(material) });
    if (this.materialStyle && !this.materialStyle.original) this.style(material, name, 1);
  }

  private restore(material: Surface, base: SurfaceSnapshot) {
    material.color.copy(base.color);
    material.metalness = base.metalness;
    material.roughness = base.roughness;
    if (base.transmission !== undefined) material.transmission = base.transmission;
    if (base.thickness !== undefined) material.thickness = base.thickness;
    if (base.attenuationColor && material.attenuationColor) material.attenuationColor.copy(base.attenuationColor);
    if (base.attenuationDistance !== undefined) material.attenuationDistance = base.attenuationDistance;
    if (base.clearcoat !== undefined) material.clearcoat = base.clearcoat;
    if (base.clearcoatRoughness !== undefined) material.clearcoatRoughness = base.clearcoatRoughness;
    material.envMapIntensity = base.envMapIntensity;
    if (base.emissive && material.emissive) material.emissive.copy(base.emissive);
    if (base.emissiveIntensity !== undefined) material.emissiveIntensity = base.emissiveIntensity;
  }

  /** Blend a surface towards the preset while preserving the per-card lift/quality animation underneath. */
  private style(material: Surface, name: string, strength: number) {
    const preset = this.materialStyle;
    if (!preset || preset.original || name === "Printed_Canvas" || name === "Printed_Label") return;
    const glass = name === "Frosted_Polymer" || name === "Subsurface_Optics" || name === "Optical_Diffuser";
    const accent = name === "Index_Inlay";
    const ink = name === "Carbon_Ink";
    const target = new THREE.Color(ink ? preset.dark : glass ? preset.glass : accent ? preset.accent : preset.metal);
    material.color.lerp(target, 0.8 * strength);
    const metalness = ink ? 0.08 : glass ? Math.min(0.18, preset.metalness * 0.16) : accent ? Math.max(0.42, preset.metalness * 0.68) : preset.metalness;
    const roughness = ink ? Math.max(0.48, preset.roughness) : glass ? Math.max(0.08, preset.roughness * 0.62) : preset.roughness;
    material.metalness = THREE.MathUtils.lerp(material.metalness, metalness, 0.72 * strength);
    material.roughness = THREE.MathUtils.lerp(material.roughness, roughness, 0.72 * strength);
    if (material.clearcoat !== undefined) material.clearcoat = THREE.MathUtils.lerp(material.clearcoat, ink ? 0.12 : preset.clearcoat, 0.68 * strength);
    if (material.clearcoatRoughness !== undefined) material.clearcoatRoughness = THREE.MathUtils.lerp(material.clearcoatRoughness, preset.clearcoatRoughness, 0.68 * strength);
    material.envMapIntensity = THREE.MathUtils.lerp(material.envMapIntensity, preset.envMapIntensity, 0.75 * strength);
    if (glass && material.transmission !== undefined && material.thickness !== undefined) {
      material.transmission = THREE.MathUtils.lerp(material.transmission, preset.transmission, 0.7 * strength);
      material.thickness = THREE.MathUtils.lerp(material.thickness, preset.thickness, 0.7 * strength);
      if (material.attenuationColor) material.attenuationColor.lerp(new THREE.Color(preset.attenuation), 0.68 * strength);
      if (material.attenuationDistance !== undefined) material.attenuationDistance = THREE.MathUtils.lerp(material.attenuationDistance, preset.attenuationDistance, 0.65 * strength);
    }
  }

  prepare(group: THREE.Group) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const name = mesh.userData.surface as string;
      const palette = this.palettes.get(name);
      if (!palette) {
        mesh.userData.themeAmount = themeMaterial(mesh.material as THREE.Material, "Printed_Canvas");
        continue;
      }
      const mat = this.cloneSource(palette.high);
      const amount = { value: 0 };
      const clarity = { value: 0 };
      mesh.material = mat;
      if (mat.userData.opticalOrder)
        mesh.renderOrder = mat.userData.opticalOrder;
      mesh.userData.appearance = amount;
      mesh.userData.glassClarity = clarity;
      mat.onBeforeCompile = (shader) => {
        if (mat.userData.opticalOrder)
          shader.fragmentShader = internalOpticsFragment(shader.fragmentShader);
        shader.uniforms.archiveQuality = amount;
        shader.uniforms.archiveClarity = clarity;
        shader.fragmentShader =
          "uniform float archiveQuality;\nuniform float archiveClarity;\n" +
          shader.fragmentShader;
        if (name === "Frosted_Polymer") {
          shader.vertexShader =
            "varying float vArchiveHeight;\nvarying vec2 vArchiveProjectedAxis;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvArchiveHeight = position.y / 3.7;",
          );
          shader.fragmentShader =
            "varying float vArchiveHeight;\nvarying vec2 vArchiveProjectedAxis;\n" +
            glassRevealGLSL +
            shader.fragmentShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <project_vertex>",
            "#include <project_vertex>\nvArchiveProjectedAxis = 1.85 * vec2(projectionMatrix[0][0] * modelViewMatrix[1][0], projectionMatrix[1][1] * modelViewMatrix[1][1]) / max(0.0001, abs(mvPosition.z));",
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <transmission_pars_fragment>",
            frostedTransmissionGLSL + "\n" + THREE.ShaderChunk.transmission_pars_fragment.replace(
              "float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );",
              "float lod = archiveTransmissionLod(roughness, ior, transmissionSamplerSize);",
            ),
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.rgb *= mix(mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vArchiveHeight)), vec3(1.0), archiveQuality);",
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(0.28, ${FROSTED_ROUGHNESS}, archiveQuality), 0.025, glassRevealAtHeight(archiveClarity, vArchiveHeight));`,
          );
        } else if (!palette.low) {
          // Stable screen-space coverage adds internal geometry without an
          // abrupt visibility toggle or a second transparent body.
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\nfloat coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\nif (archiveQuality <= coverage) discard;",
          );
        }
      };
      mat.customProgramCacheKey = () =>
        `archive-surface-clarity-${name}-${Boolean(palette.low)}`;
      this.track(mat, name);
      mesh.userData.subduedIndex = { value: 0 };
      mesh.userData.themeAmount = themeMaterial(mat, name, false, mesh.userData.subduedIndex);
    }
  }

  setClarity(group: THREE.Group, value: number) {
    const clarity = THREE.MathUtils.clamp(value, 0, 1);
    // Traversal still works after the viewer reparents meshes into part groups.
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.userData.glassClarity)
        return;
      child.userData.glassClarity.value = clarity;
      if (child.userData.surface !== "Frosted_Polymer") return;
      const mat = child.material as Surface;
      const palette = this.palettes.get("Frosted_Polymer")!;
      const quality = child.userData.appearance.value as number;
      const baseline = (
        key: "thickness" | "transmission" | "attenuationDistance",
      ) =>
        THREE.MathUtils.lerp(
          palette.low?.[key] ?? palette.high[key],
          palette.high[key],
          quality,
        );
      mat.thickness = THREE.MathUtils.lerp(
        baseline("thickness"),
        0.018,
        clarity,
      );
      mat.transmission = THREE.MathUtils.lerp(
        baseline("transmission"),
        0.985,
        clarity,
      );
      mat.attenuationDistance = THREE.MathUtils.lerp(
        baseline("attenuationDistance"),
        8,
        clarity,
      );
    });
  }

  setTheme(group: THREE.Group, value: number, subduedIndex: boolean | number = false) {
    group.traverse(child => {
      if (child.userData.themeAmount) child.userData.themeAmount.value = value;
      if (child.userData.subduedIndex) child.userData.subduedIndex.value = THREE.MathUtils.clamp(Number(subduedIndex), 0, 1);
    });
  }

  apply(group: THREE.Group, value: number) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const palette = this.palettes.get(mesh.userData.surface);
      if (!palette) {
        // The printed canvas belongs to this file, including returning copies.
        (mesh.material as THREE.MeshBasicMaterial).opacity = value;
        continue;
      }
      mesh.userData.appearance.value = value;
      const { high, low } = palette;
      if (!low) continue;
      const mat = mesh.material as Surface;
      mat.color.copy(low.color).lerp(high.color, value);
      if (
        mat.attenuationColor &&
        low.attenuationColor &&
        high.attenuationColor
      ) {
        mat.attenuationColor
          .copy(low.attenuationColor)
          .lerp(high.attenuationColor, value);
        mat.attenuationDistance =
          Number.isFinite(low.attenuationDistance) &&
          Number.isFinite(high.attenuationDistance)
            ? THREE.MathUtils.lerp(
                low.attenuationDistance,
                high.attenuationDistance,
                value,
              )
            : high.attenuationDistance;
      }
      for (const key of [
        "roughness",
        "metalness",
        "transmission",
        "thickness",
        "clearcoat",
        "clearcoatRoughness",
      ] as const) {
        mat[key] = THREE.MathUtils.lerp(low[key] ?? 0, high[key] ?? 0, value);
      }
      // Keep the same transmission shader/pass throughout the transition.
      if (high.transmission > 0)
        mat.transmission = Math.max(0.000001, mat.transmission);
      this.style(mat, String(mesh.userData.surface), 1);
    }
  }

  dispose(group: THREE.Group) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (!mesh.userData.surface) mat.map?.dispose();
      mat.dispose();
    }
  }
}
