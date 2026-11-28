import { WATER_RING_DEFAULTS, getWaterRingTuning, updateWaterRingTuning, type WaterRingTuning } from "../water-mobius-ring";

const STORAGE_KEY = "vitrine.waterRingTuning.v1";

interface Spec {
  key: Exclude<keyof WaterRingTuning, "color">;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
}

const SPECS: Spec[] = [
  { key: "widthScale", label: "水膜宽度", min: 0.4, max: 1.6, step: 0.01 },
  { key: "waveAmplitude", label: "波纹幅度", min: 0, max: 0.16, step: 0.001 },
  { key: "waveSpeed", label: "流动速度", min: 0, max: 3, step: 0.01 },
  { key: "opacity", label: "不透明度", min: 0.1, max: 1, step: 0.01 },
  { key: "transmission", label: "透射", min: 0, max: 1, step: 0.01 },
  { key: "ior", label: "折射率", min: 1, max: 2.5, step: 0.01 },
  { key: "roughness", label: "粗糙度", min: 0, max: 0.3, step: 0.005 },
  { key: "envMapIntensity", label: "环境反射", min: 0, max: 3, step: 0.01 },
];

function load(): Partial<WaterRingTuning> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<WaterRingTuning>) : {};
  } catch {
    return {};
  }
}

export function installWaterRingTuner(): () => void {
  const state: WaterRingTuning = { ...WATER_RING_DEFAULTS, ...getWaterRingTuning(), ...load() };
  const panel = document.createElement("section");
  panel.className = "glass-tuner water-tuner";
  panel.dataset.open = "false";
  panel.setAttribute("aria-label", "液态莫比乌斯环调参");
  panel.innerHTML = `
    <header class="glass-tuner-head">
      <div><b>液态莫比乌斯环</b><span>按 U 开关</span></div>
      <button type="button" class="glass-tuner-close" aria-label="关闭">×</button>
    </header>
    <div class="glass-tuner-body"></div>
    <label class="glass-tuner-row water-color-row"><span>水色</span><input type="color"><output></output></label>
    <footer class="glass-tuner-foot">
      <button type="button" data-water="reset">重置</button>
      <button type="button" data-water="copy">复制参数</button>
    </footer>`;
  const body = panel.querySelector<HTMLElement>(".glass-tuner-body")!;
  const outputs = new Map<Spec["key"], HTMLOutputElement>();
  for (const spec of SPECS) {
    const row = document.createElement("label");
    row.className = "glass-tuner-row";
    row.innerHTML = `<span>${spec.label}</span><input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}"><output></output>`;
    const input = row.querySelector<HTMLInputElement>("input")!;
    const output = row.querySelector<HTMLOutputElement>("output")!;
    input.value = String(state[spec.key]);
    output.value = `${input.value}${spec.suffix ?? ""}`;
    outputs.set(spec.key, output);
    input.addEventListener("input", () => {
      (state[spec.key] as number) = Number(input.value);
      output.value = `${input.value}${spec.suffix ?? ""}`;
      apply();
    });
    body.append(row);
  }
  const colorInput = panel.querySelector<HTMLInputElement>(".water-color-row input")!;
  const colorOutput = panel.querySelector<HTMLOutputElement>(".water-color-row output")!;
  colorInput.value = state.color;
  colorOutput.value = state.color;
  colorInput.addEventListener("input", () => {
    state.color = colorInput.value;
    colorOutput.value = state.color;
    apply();
  });

  const apply = () => {
    updateWaterRingTuning(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* optional */
    }
  };
  const refresh = () => {
    for (const spec of SPECS) {
      const input = panel.querySelector<HTMLInputElement>(`input[data-water-key="${spec.key}"]`);
      void input;
      const rows = panel.querySelectorAll<HTMLInputElement>(".glass-tuner-row input[type=range]");
      void rows;
      const output = outputs.get(spec.key);
      if (output) output.value = `${state[spec.key]}${spec.suffix ?? ""}`;
    }
    colorInput.value = state.color;
    colorOutput.value = state.color;
  };
  // Give each range a stable key so reset can refresh it.
  panel.querySelectorAll<HTMLInputElement>(".glass-tuner-body input[type=range]").forEach((input, index) => {
    const spec = SPECS[index];
    if (!spec) return;
    input.dataset.waterKey = spec.key;
    input.value = String(state[spec.key]);
  });

  const toggle = (open = panel.dataset.open !== "true") => {
    panel.dataset.open = String(open);
    panel.setAttribute("aria-hidden", String(!open));
  };
  panel.querySelector(".glass-tuner-close")!.addEventListener("click", () => toggle(false));
  panel.querySelector('[data-water="reset"]')!.addEventListener("click", () => {
    Object.assign(state, WATER_RING_DEFAULTS);
    panel.querySelectorAll<HTMLInputElement>(".glass-tuner-body input[type=range]").forEach((input) => {
      const key = input.dataset.waterKey as Spec["key"] | undefined;
      if (key) input.value = String(state[key]);
    });
    refresh();
    apply();
  });
  panel.querySelector('[data-water="copy"]')!.addEventListener("click", () => {
    void navigator.clipboard?.writeText(JSON.stringify(state, null, 2));
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
  apply();
  return () => {
    window.removeEventListener("keydown", onKey);
    panel.remove();
  };
}
