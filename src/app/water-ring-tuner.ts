import { WATER_RING_DEFAULTS, getWaterRingTuning, updateWaterRingTuning, type WaterRingTuning } from "../water-mobius-ring";
import { WATER_CARD_DEFAULTS, getWaterCardTuning, updateWaterCardTuning, type WaterCardTuning } from "../water-card";

const RING_KEY = "vitrine.waterRingTuning.v1";
const CARD_KEY = "vitrine.waterCardTuning.v1";

interface Spec<K extends string> {
  key: K;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
}

const RING_SPECS: Spec<Exclude<keyof WaterRingTuning, "color" | "attenuation">>[] = [
  { key: "widthScale", label: "水膜宽度", min: 0.4, max: 1.6, step: 0.01 },
  { key: "waveAmplitude", label: "波纹幅度", min: 0, max: 0.5, step: 0.001 },
  { key: "waveFrequency", label: "波纹频率", min: 0, max: 14, step: 0.1 },
  { key: "waveSpeed", label: "流动速度", min: 0, max: 5, step: 0.01 },
  { key: "flowScale", label: "流动尺度", min: 0, max: 6, step: 0.01 },
  { key: "turbulence", label: "湍流", min: 0, max: 0.2, step: 0.001 },
  { key: "opacity", label: "不透明度", min: 0.1, max: 1, step: 0.01 },
  { key: "transmission", label: "透射", min: 0, max: 1, step: 0.01 },
  { key: "ior", label: "折射率", min: 1, max: 2.5, step: 0.01 },
  { key: "roughness", label: "粗糙度", min: 0, max: 0.3, step: 0.005 },
  { key: "clearcoat", label: "清漆", min: 0, max: 1, step: 0.01 },
  { key: "clearcoatRoughness", label: "清漆粗糙度", min: 0, max: 0.3, step: 0.005 },
  { key: "dispersion", label: "色散", min: 0, max: 0.1, step: 0.001 },
  { key: "attenuationDistance", label: "衰减距离", min: 0.5, max: 15, step: 0.1 },
  { key: "envMapIntensity", label: "环境反射", min: 0, max: 3, step: 0.01 },
  { key: "bumpScale", label: "波纹凹凸", min: 0, max: 0.08, step: 0.001 },
];

const CARD_SPECS: Spec<keyof WaterCardTuning>[] = [
  { key: "width", label: "卡片宽度", min: 2.2, max: 14, step: 0.01 },
  { key: "height", label: "卡片高度", min: 1.4, max: 10, step: 0.01 },
  { key: "depth", label: "实体厚度", min: 0.24, max: 3, step: 0.01 },
  { key: "bevel", label: "边缘圆角", min: 0.04, max: 1.5, step: 0.005 },
  { key: "segments", label: "倒角细分", min: 4, max: 32, step: 1 },
  { key: "amplitude", label: "卡片起伏", min: 0.005, max: 0.5, step: 0.001 },
  { key: "frequency", label: "水波频率", min: 0.4, max: 8, step: 0.05 },
  { key: "speed", label: "表面流速", min: 0, max: 3, step: 0.01 },
  { key: "detail", label: "细节水纹", min: 0, max: 0.05, step: 0.001 },
];

function load<T>(key: string): Partial<T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch {
    return {};
  }
}

function bindSliders<K extends string>(
  container: HTMLElement,
  specs: Spec<K>[],
  state: Record<K, number>,
  apply: () => void,
): () => void {
  const outputs = new Map<K, HTMLOutputElement>();
  for (const spec of specs) {
    const row = document.createElement("label");
    row.className = "glass-tuner-row";
    row.innerHTML = `<span>${spec.label}</span><input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}"><output></output>`;
    const input = row.querySelector<HTMLInputElement>("input")!;
    const output = row.querySelector<HTMLOutputElement>("output")!;
    input.dataset.waterKey = spec.key;
    input.value = String(state[spec.key]);
    output.value = `${input.value}${spec.suffix ?? ""}`;
    outputs.set(spec.key, output);
    input.addEventListener("input", () => {
      state[spec.key] = Number(input.value) as Record<K, number>[K];
      output.value = `${input.value}${spec.suffix ?? ""}`;
      apply();
    });
    container.append(row);
  }
  return () => {
    for (const spec of specs) {
      const input = container.querySelector<HTMLInputElement>(`input[data-water-key="${spec.key}"]`);
      const output = outputs.get(spec.key);
      if (input) input.value = String(state[spec.key]);
      if (output) output.value = `${state[spec.key]}${spec.suffix ?? ""}`;
    }
  };
}

export function installWaterRingTuner(): () => void {
  const ring: WaterRingTuning = { ...WATER_RING_DEFAULTS, ...getWaterRingTuning(), ...load<WaterRingTuning>(RING_KEY) };
  const card: WaterCardTuning = { ...WATER_CARD_DEFAULTS, ...getWaterCardTuning(), ...load<WaterCardTuning>(CARD_KEY) };
  const panel = document.createElement("section");
  panel.className = "glass-tuner water-tuner";
  panel.dataset.open = "false";
  panel.setAttribute("aria-label", "液态水体调参");
  panel.innerHTML = `
    <header class="glass-tuner-head">
      <div><b>液态水体</b><span>按 U 开关</span></div>
      <button type="button" class="glass-tuner-close" aria-label="关闭">×</button>
    </header>
    <div class="water-section-title">莫比乌斯水环</div>
    <div class="glass-tuner-body" data-water-ring></div>
    <label class="glass-tuner-row water-color-row"><span>水色</span><input type="color" data-water-color="color"><output></output></label>
    <label class="glass-tuner-row water-color-row"><span>衰减色</span><input type="color" data-water-color="attenuation"><output></output></label>
    <div class="water-section-title">厚实水卡片</div>
    <div class="glass-tuner-body" data-water-card></div>
    <footer class="glass-tuner-foot">
      <button type="button" data-water="reset">重置</button>
      <button type="button" data-water="copy">复制参数</button>
    </footer>`;
  const ringHost = panel.querySelector<HTMLElement>("[data-water-ring]")!;
  const cardHost = panel.querySelector<HTMLElement>("[data-water-card]")!;

  const applyRing = () => {
    updateWaterRingTuning(ring);
    try { localStorage.setItem(RING_KEY, JSON.stringify(ring)); } catch { /* optional */ }
  };
  const applyCard = () => {
    updateWaterCardTuning(card);
    try { localStorage.setItem(CARD_KEY, JSON.stringify(card)); } catch { /* optional */ }
  };
  const refreshRing = bindSliders(ringHost, RING_SPECS, ring as unknown as Record<typeof RING_SPECS[number]["key"], number>, applyRing);
  const refreshCard = bindSliders(cardHost, CARD_SPECS, card, applyCard);
  const colorInputs = [...panel.querySelectorAll<HTMLInputElement>("input[data-water-color]")];
  const colorOutputs = [...panel.querySelectorAll<HTMLOutputElement>(".water-color-row output")];
  const refreshColors = () => colorInputs.forEach((input, index) => {
    const key = input.dataset.waterColor as "color" | "attenuation";
    input.value = ring[key];
    colorOutputs[index].value = ring[key];
  });
  colorInputs.forEach((input, index) => {
    const key = input.dataset.waterColor as "color" | "attenuation";
    input.addEventListener("input", () => {
      ring[key] = input.value;
      colorOutputs[index].value = input.value;
      applyRing();
    });
  });
  refreshColors();

  const toggle = (open = panel.dataset.open !== "true") => {
    panel.dataset.open = String(open);
    panel.setAttribute("aria-hidden", String(!open));
  };
  panel.querySelector(".glass-tuner-close")!.addEventListener("click", () => toggle(false));
  panel.querySelector('[data-water="reset"]')!.addEventListener("click", () => {
    Object.assign(ring, WATER_RING_DEFAULTS);
    Object.assign(card, WATER_CARD_DEFAULTS);
    refreshRing();
    refreshCard();
    refreshColors();
    applyRing();
    applyCard();
  });
  panel.querySelector('[data-water="copy"]')!.addEventListener("click", () => {
    void navigator.clipboard?.writeText(JSON.stringify({ waterRing: ring, waterCard: card }, null, 2));
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key.toLowerCase() !== "u") return;
    event.preventDefault();
    toggle();
  };
  window.addEventListener("keydown", onKey);
  document.body.append(panel);
  applyRing();
  applyCard();
  return () => {
    window.removeEventListener("keydown", onKey);
    panel.remove();
  };
}
