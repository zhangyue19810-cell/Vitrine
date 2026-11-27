import { updateGlassTuning, type GlassTuning } from "./liquid-glass";

const STORAGE_KEY = "vitrine.glassTuning.v1";

const DEFAULTS: GlassTuning = {
  thickness: 122,
  bezel: 44,
  ior: 2.34,
  scale: 2,
  blur: 0,
  specular: 0.18,
  tint: 0,
  innerBlur: 20,
  innerSpread: -5,
  outerBlur: 24,
  outerOpacity: 0.18,
};

interface ControlSpec {
  key: keyof GlassTuning;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  scale?: number;
}

const CONTROLS: ControlSpec[] = [
  { key: "thickness", label: "厚度", min: 20, max: 220, step: 1 },
  { key: "bezel", label: "Bezel 宽度", min: 5, max: 100, step: 1 },
  { key: "ior", label: "折射率 IOR", min: 1, max: 3.5, step: 0.01 },
  { key: "scale", label: "缩放 Scale", min: 0.5, max: 3, step: 0.01 },
  { key: "blur", label: "附加模糊", min: 0, max: 30, step: 1, suffix: "px" },
  { key: "specular", label: "高光", min: 0, max: 0.6, step: 0.01 },
  { key: "tint", label: "Tint 白色", min: 0, max: 20, step: 1, suffix: "%", scale: 100 },
  { key: "innerBlur", label: "内阴影模糊", min: 0, max: 40, step: 1, suffix: "px" },
  { key: "innerSpread", label: "内阴影扩散", min: -20, max: 10, step: 1, suffix: "px" },
  { key: "outerBlur", label: "外阴影模糊", min: 0, max: 50, step: 1, suffix: "px" },
  { key: "outerOpacity", label: "外阴影不透明度", min: 0, max: 0.6, step: 0.01 },
];

function readStored(): Partial<GlassTuning> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<GlassTuning>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function installGlassTuner(): () => void {
  const state: GlassTuning = { ...DEFAULTS, ...readStored() };
  const panel = document.createElement("section");
  panel.className = "glass-tuner";
  panel.dataset.open = "false";
  panel.setAttribute("aria-label", "液态玻璃调参");
  panel.innerHTML = `
    <header class="glass-tuner-head">
      <div><b>液态玻璃</b><span>按 Y 开关</span></div>
      <button type="button" class="glass-tuner-close" aria-label="关闭">×</button>
    </header>
    <div class="glass-tuner-body"></div>
    <footer class="glass-tuner-foot">
      <button type="button" data-tuner="reset">重置</button>
      <button type="button" data-tuner="copy">复制参数</button>
    </footer>`;
  const body = panel.querySelector<HTMLElement>(".glass-tuner-body")!;
  const outputs = new Map<keyof GlassTuning, HTMLOutputElement>();

  for (const spec of CONTROLS) {
    const row = document.createElement("label");
    row.className = "glass-tuner-row";
    const scale = spec.scale ?? 1;
    row.innerHTML = `<span>${spec.label}</span><input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}"><output></output>`;
    const input = row.querySelector<HTMLInputElement>("input")!;
    const output = row.querySelector<HTMLOutputElement>("output")!;
    input.dataset.key = spec.key;
    input.value = String(state[spec.key] * scale);
    output.value = `${input.value}${spec.suffix ?? ""}`;
    outputs.set(spec.key, output);
    input.addEventListener("input", () => {
      const value = Number(input.value) / scale;
      (state[spec.key] as number) = value;
      output.value = `${input.value}${spec.suffix ?? ""}`;
      apply();
    });
    body.append(row);
  }

  const apply = () => {
    updateGlassTuning(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage is optional */
    }
  };

  const refresh = () => {
    for (const spec of CONTROLS) {
      const input = body.querySelector<HTMLInputElement>(`input[data-key="${spec.key}"]`);
      const output = outputs.get(spec.key);
      if (!input || !output) continue;
      const scale = spec.scale ?? 1;
      input.value = String(state[spec.key] * scale);
      output.value = `${input.value}${spec.suffix ?? ""}`;
    }
  };

  const copy = async () => {
    const json = {
      glassThickness: state.thickness,
      bezelWidth: state.bezel,
      refractiveIndex: state.ior,
      scaleRatio: state.scale,
      cornerRadius: 46,
      blur: state.blur,
      specularOpacity: state.specular,
      specularSaturation: 4,
      tint: { color: "#ffffff", opacityPercent: Math.round(state.tint * 100) },
      innerShadow: { color: "#ffffff", blur: state.innerBlur, spread: state.innerSpread },
      outerShadow: { color: "#000000", blur: state.outerBlur, opacity: state.outerOpacity },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
      const button = panel.querySelector<HTMLButtonElement>('[data-tuner="copy"]')!;
      button.textContent = "已复制";
      window.setTimeout(() => (button.textContent = "复制参数"), 1000);
    } catch {
      console.info("Vitrine glass parameters", json);
    }
  };

  panel.querySelector(".glass-tuner-close")!.addEventListener("click", () => toggle(false));
  panel.querySelector('[data-tuner="reset"]')!.addEventListener("click", () => {
    Object.assign(state, DEFAULTS);
    refresh();
    apply();
  });
  panel.querySelector('[data-tuner="copy"]')!.addEventListener("click", () => void copy());

  const toggle = (open = panel.dataset.open !== "true") => {
    panel.dataset.open = String(open);
    panel.setAttribute("aria-hidden", String(!open));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key.toLowerCase() !== "y") return;
    event.preventDefault();
    toggle();
  };

  window.addEventListener("keydown", onKeyDown);
  document.body.append(panel);
  toggle(false);
  apply();

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    panel.remove();
  };
}
