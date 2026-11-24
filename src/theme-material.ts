import * as THREE from "three";

/** The dark theme's colours of the cassette's parts: smoked glass and warm metal, so that the lights find gold on them. */
const surfaces: Record<string, string> = {
  Frosted_Polymer: "#675f50", Ivory_Edges: "#746a57", Optical_Diffuser: "#1e1a13",
  Titanium_Fasteners: "#bfb39a", Index_Inlay: "#d9aa58", Printed_Label: "#2c271e",
  Subsurface_Optics: "#a39880", Optical_Edges: "#c8bda3", Carbon_Ink: "#c3b89e",
};
/** Extend existing optical shaders; one float per instance avoids new meshes or passes. */
export function themeMaterial(material: THREE.Material, name: string, instanced = false, subduedIndex = { value: 0 }) {
  const amount = { value: 0 };
  const before = material.onBeforeCompile;
  const cache = material.customProgramCacheKey.bind(material)();
  const color = new THREE.Color(surfaces[name] ?? (name.includes("Orange") ? "#bb8850" : "#969f9f"));
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.rhineTheme = amount;
    shader.uniforms.rhineDarkSurface = { value: color };
    shader.uniforms.rhineSubduedIndex = subduedIndex;
    if (instanced) {
      shader.vertexShader = "attribute float archiveTheme; varying float vRhineTheme;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvRhineTheme = archiveTheme;");
      shader.fragmentShader = "varying float vRhineTheme;\n" + shader.fragmentShader;
    }
    shader.fragmentShader = "uniform float rhineTheme; uniform vec3 rhineDarkSurface; uniform float rhineSubduedIndex;\n" + shader.fragmentShader;
    const mix = instanced ? "vRhineTheme" : "rhineTheme";
    const printed = name === "Printed_Canvas";
    const anchor = printed ? "#include <opaque_fragment>" : "#include <roughnessmap_fragment>";
    const dark = printed
      ? "mix(vec3(0.030, 0.024, 0.016), vec3(0.80, 0.76, 0.67), 1.0 - smoothstep(0.12, 0.65, dot(diffuseColor.rgb, vec3(.2126,.7152,.0722))))"
      : name === "Frosted_Polymer" && !instanced
        ? "mix(rhineDarkSurface, vec3(0.92, 0.96, 0.97), glassRevealAtHeight(archiveClarity, vArchiveHeight))"
        : name === "Index_Inlay" ? "mix(rhineDarkSurface, vec3(0.042, 0.031, 0.014), rhineSubduedIndex)" : "rhineDarkSurface";
    const output = printed ? "outgoingLight" : "diffuseColor.rgb";
    shader.fragmentShader = shader.fragmentShader.replace(anchor, `${output} = mix(${output}, ${dark}, ${mix});\n${anchor}`);
  };
  material.customProgramCacheKey = () => `${cache}-rhine-theme-${name}-${instanced}`;
  return amount;
}

type Baseline = { background: THREE.Color; fog?: THREE.Color; intensity: number; exposure: number; lights: { light: THREE.Light; intensity: number; color: THREE.Color }[]; floor?: { material: THREE.MeshStandardMaterial; color: THREE.Color } };
const scenes = new WeakMap<THREE.Scene, Baseline>();
const background = new THREE.Color("#010101"), floorColor = new THREE.Color("#040403"), mistColor = new THREE.Color("#080604");
/** Deep space: the darkest the scene gets (a warm near-black), whatever the theme is. */
const deepBackground = new THREE.Color("#010101"), deepMist = new THREE.Color("#030302");
/** The lights of the dark theme lean towards the gold of the accretion disk. */
const warmLight = new THREE.Color("#ffd9a3");
/**
 * Set the colours, the fog, the exposure and the lights of the scene from the theme (`amount`: 0 light … 1 dark). `deep`
 * (0 … 1) then carries the scene on into deep space (the cosmos of the music page): the same for either theme.
 */
export function themeEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, amount: number, deep = 0) {
  let baseline = scenes.get(scene);
  if (!baseline) {
    const lights: Baseline["lights"] = [];
    scene.traverse(object => { if (object instanceof THREE.Light && !object.userData.ownLight) lights.push({ light: object, intensity: object.intensity, color: object.color.clone() }); });
    const floor = scene.getObjectByName("archive-floor") as THREE.Mesh | undefined;
    const material = floor?.material as THREE.MeshStandardMaterial | undefined;
    baseline = { background: (scene.background as THREE.Color).clone(), fog: scene.fog?.color.clone(), intensity: scene.environmentIntensity,
      exposure: renderer.toneMappingExposure, lights, floor: material ? { material, color: material.color.clone() } : undefined };
    scenes.set(scene, baseline);
  }
  (scene.background as THREE.Color).copy(baseline.background).lerp(background, amount).lerp(deepBackground, deep);
  if (scene.fog && baseline.fog) scene.fog.color.copy(baseline.fog).lerp(mistColor, amount).lerp(deepMist, deep);
  if (baseline.floor) baseline.floor.material.color.copy(baseline.floor.color).lerp(floorColor, amount).lerp(deepBackground, deep);
  // The dark look still needs a living environment: reduce the studio only
  // enough to keep the black-gold contrast, never so far that clearcoat and
  // titanium reflections collapse into flat silhouettes.
  scene.environmentIntensity = THREE.MathUtils.lerp(THREE.MathUtils.lerp(baseline.intensity, .38, amount), .23, deep);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(THREE.MathUtils.lerp(baseline.exposure, .96, amount), 1.02, deep);
  for (const { light, intensity, color } of baseline.lights) {
    light.intensity = intensity * (1 - .28 * amount) * (1 - .08 * deep);
    light.color.copy(color).lerp(warmLight, .6 * amount);
  }
}
