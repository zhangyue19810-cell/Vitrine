/**
 * PBR looks for the Möbius archive ring.
 *
 * The GLB is built from glass, metal, inlay and printed-label surfaces. A
 * preset therefore does not recolour one flat mesh: it gives each material
 * family its own metal/roughness/clearcoat/transmission response, so the ring
 * keeps readable highlights and depth at every angle.
 */

export type RingMaterialId = "black-gold" | "crimson" | "violet" | "azure" | "pearl" | "jade" | "copper" | "obsidian" | "carbon" | "flow-white";

export interface RingMaterialPreset {
  id: RingMaterialId;
  label: string;
  tag: string;
  description: string;
  swatch: string;
  metal: string;
  glass: string;
  accent: string;
  dark: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  envMapIntensity: number;
  transmission: number;
  thickness: number;
  attenuation: string;
  attenuationDistance: number;
  /** Keep the original studio-glass materials instead of overriding them. */
  original?: boolean;
}

export const RING_MATERIALS: readonly RingMaterialPreset[] = [
  {
    id: "black-gold",
    label: "黑金玻璃",
    tag: "ORIGINAL PBR",
    description: "原版烟熏玻璃与暖金钛金属，保留现有工作室反射。",
    swatch: "linear-gradient(135deg,#17130d,#f1c370)",
    metal: "#d6c09a",
    glass: "#726858",
    accent: "#c6a05f",
    dark: "#242017",
    metalness: 0.9,
    roughness: 0.2,
    clearcoat: 0.7,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.8,
    transmission: 0.64,
    thickness: 0.3,
    attenuation: "#cdb79e",
    attenuationDistance: 1.35,
    original: true,
  },
  {
    id: "crimson",
    label: "猩红烤漆",
    tag: "AUTOMOTIVE PBR",
    description: "深红金属底漆、高光清漆与酒红色透光玻璃。",
    swatch: "linear-gradient(135deg,#31060b,#e84c5c)",
    metal: "#a9323c",
    glass: "#3b0b12",
    accent: "#ff6b76",
    dark: "#1d070a",
    metalness: 0.86,
    roughness: 0.24,
    clearcoat: 0.96,
    clearcoatRoughness: 0.08,
    envMapIntensity: 2.0,
    transmission: 0.54,
    thickness: 0.36,
    attenuation: "#7f1524",
    attenuationDistance: 1.1,
  },
  {
    id: "violet",
    label: "紫晶镀层",
    tag: "SATIN METAL",
    description: "紫罗兰缎面金属与透明紫晶边缘，柔和高光。",
    swatch: "linear-gradient(135deg,#201137,#a37bff)",
    metal: "#7450c9",
    glass: "#1c1233",
    accent: "#c5a7ff",
    dark: "#120d20",
    metalness: 0.9,
    roughness: 0.18,
    clearcoat: 0.82,
    clearcoatRoughness: 0.11,
    envMapIntensity: 2.15,
    transmission: 0.62,
    thickness: 0.28,
    attenuation: "#5e41a0",
    attenuationDistance: 1.3,
  },
  {
    id: "azure",
    label: "极光蓝",
    tag: "GLASS / CHROME",
    description: "电镀蓝金属配冷色透明玻璃，清透如冰。",
    swatch: "linear-gradient(135deg,#071c33,#64c9ff)",
    metal: "#2e7ec9",
    glass: "#081b2c",
    accent: "#7bd2ff",
    dark: "#07121d",
    metalness: 0.82,
    roughness: 0.15,
    clearcoat: 0.94,
    clearcoatRoughness: 0.07,
    envMapIntensity: 2.25,
    transmission: 0.72,
    thickness: 0.22,
    attenuation: "#2d75a5",
    attenuationDistance: 1.55,
  },
  {
    id: "pearl",
    label: "珍珠白",
    tag: "SOFT CERAMIC",
    description: "奶白陶瓷与柔光玻璃，低金属度、细腻缎面。",
    swatch: "linear-gradient(135deg,#d7cec0,#fff9ec)",
    metal: "#e3d8c7",
    glass: "#c8b9a4",
    accent: "#fff2d6",
    dark: "#4a4034",
    metalness: 0.18,
    roughness: 0.4,
    clearcoat: 0.45,
    clearcoatRoughness: 0.3,
    envMapIntensity: 1.35,
    transmission: 0.64,
    thickness: 0.42,
    attenuation: "#cfc1ae",
    attenuationDistance: 2.2,
  },
  {
    id: "jade",
    label: "翡翠青",
    tag: "GREEN ENAMEL",
    description: "青玉珐琅与墨绿玻璃，柔和清冷的环境反射。",
    swatch: "linear-gradient(135deg,#06241a,#5ee0ad)",
    metal: "#237c5d",
    glass: "#071e16",
    accent: "#77e8bf",
    dark: "#07140f",
    metalness: 0.68,
    roughness: 0.3,
    clearcoat: 0.74,
    clearcoatRoughness: 0.16,
    envMapIntensity: 1.72,
    transmission: 0.58,
    thickness: 0.34,
    attenuation: "#1b5e46",
    attenuationDistance: 1.25,
  },
  {
    id: "copper",
    label: "玫瑰铜",
    tag: "POLISHED PBR",
    description: "高反射玫瑰铜与琥珀玻璃，接近珠宝的暖光。",
    swatch: "linear-gradient(135deg,#3b160d,#ffb47c)",
    metal: "#b96d3b",
    glass: "#32170e",
    accent: "#ffb177",
    dark: "#1d0d08",
    metalness: 0.97,
    roughness: 0.2,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    envMapIntensity: 2.3,
    transmission: 0.48,
    thickness: 0.3,
    attenuation: "#8f4c2c",
    attenuationDistance: 1.15,
  },
  {
    id: "obsidian",
    label: "曜石金",
    tag: "BLACK METAL",
    description: "近黑镜面金属、极细金色嵌线，低透光深邃质感。",
    swatch: "linear-gradient(135deg,#030304,#4b4740 54%,#d8a84f)",
    metal: "#28272b",
    glass: "#09090b",
    accent: "#d9aa58",
    dark: "#030304",
    metalness: 0.96,
    roughness: 0.12,
    clearcoat: 0.9,
    clearcoatRoughness: 0.05,
    envMapIntensity: 2.5,
    transmission: 0.22,
    thickness: 0.5,
    attenuation: "#3f3426",
    attenuationDistance: 0.9,
  },
  {
    id: "flow-white",
    label: "流光白",
    tag: "PEARL / FLOW",
    description: "冷白珠光玻璃，环体表面有沿莫比乌斯带流动的银白光带。",
    swatch: "linear-gradient(135deg,#737b88,#f7f9ff 42%,#d6e8ff 68%,#ffffff)",
    metal: "#c5cbd5",
    glass: "#dbe1e9",
    accent: "#ffffff",
    dark: "#8b929d",
    metalness: 0.34,
    roughness: 0.26,
    clearcoat: 0.86,
    clearcoatRoughness: 0.1,
    envMapIntensity: 2.05,
    transmission: 0.46,
    thickness: 0.38,
    attenuation: "#eef3fb",
    attenuationDistance: 1.9,
  },
  {
    id: "carbon",
    label: "碳纤维",
    tag: "MATTE COMPOSITE",
    description: "低反光碳灰与钛银镶边，适合低画质和夜间的沉稳外观。",
    swatch: "linear-gradient(135deg,#0a0b0c,#494d52 52%,#aeb4bb)",
    metal: "#3a3e43",
    glass: "#111417",
    accent: "#aab1b8",
    dark: "#08090a",
    metalness: 0.34,
    roughness: 0.64,
    clearcoat: 0.16,
    clearcoatRoughness: 0.52,
    envMapIntensity: 0.95,
    transmission: 0.16,
    thickness: 0.42,
    attenuation: "#3f4348",
    attenuationDistance: 1.1,
  },
] as const;

export const RING_MATERIAL_BY_ID = new Map<RingMaterialId, RingMaterialPreset>(RING_MATERIALS.map((entry) => [entry.id, entry]));

export function ringMaterialById(id: string | undefined): RingMaterialPreset {
  return RING_MATERIAL_BY_ID.get(id as RingMaterialId) ?? RING_MATERIALS[0];
}
