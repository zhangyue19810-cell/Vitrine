import { ringMaterialById, type RingMaterialId, type RingMaterialPreset } from "../ring-materials";

export interface BackgroundSettings {
  kind: "none" | "image" | "video";
  /** Absolute local path. The desktop shell turns it into a safe media URL. */
  path: string;
  name: string;
  /** 0 … 1 darkening of the media so glass text remains readable. */
  dim: number;
  /** Blur in stage pixels; 0 keeps the wallpaper crisp. */
  blur: number;
  /** Simulated depth: 0 = flat, 1 = deep parallax and focus falloff. */
  depth: number;
  paused: boolean;
}

export interface VisualPreferencesState {
  ringMaterial: RingMaterialId;
  background: BackgroundSettings;
}

const KEY = "vitrine.visuals.v1";

const DEFAULT_BACKGROUND: BackgroundSettings = { kind: "none", path: "", name: "", dim: 0.4, blur: 10, depth: 0.72, paused: false };
const DEFAULT_STATE: VisualPreferencesState = { ringMaterial: "black-gold", background: { ...DEFAULT_BACKGROUND } };

function read(): VisualPreferencesState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE, background: { ...DEFAULT_BACKGROUND } };
    const value = JSON.parse(raw) as Partial<VisualPreferencesState> | undefined;
    const background = { ...DEFAULT_BACKGROUND, ...(value?.background ?? {}) };
    if (!["none", "image", "video"].includes(background.kind)) background.kind = "none";
    return {
      ringMaterial: ringMaterialById(String(value?.ringMaterial)).id,
      background: {
        ...background,
        dim: Math.max(0, Math.min(0.9, Number(background.dim) || 0)),
        blur: Math.max(0, Math.min(36, Number(background.blur) || 0)),
        depth: Math.max(0, Math.min(1, Number(background.depth) || 0)),
        paused: Boolean(background.paused),
      },
    };
  } catch {
    return { ...DEFAULT_STATE, background: { ...DEFAULT_BACKGROUND } };
  }
}

/** A tiny app-wide preference store for visual choices that live in CSS/WebGL rather than the core settings file. */
class VisualPreferences {
  private state = read();
  private readonly listeners = new Set<(state: VisualPreferencesState) => void>();

  get(): VisualPreferencesState {
    return { ...this.state, background: { ...this.state.background } };
  }

  get material(): RingMaterialPreset {
    return ringMaterialById(this.state.ringMaterial);
  }

  subscribe(listener: (state: VisualPreferencesState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* private mode: the current session still uses the choice */
    }
    const snapshot = this.get();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("visual preference listener failed", error);
      }
    }
  }

  setRingMaterial(id: RingMaterialId) {
    if (this.state.ringMaterial === id) return;
    this.state.ringMaterial = ringMaterialById(id).id;
    this.commit();
  }

  setBackground(patch: Partial<BackgroundSettings>) {
    this.state.background = {
      ...this.state.background,
      ...patch,
      dim: Math.max(0, Math.min(0.9, Number(patch.dim ?? this.state.background.dim))),
      blur: Math.max(0, Math.min(36, Number(patch.blur ?? this.state.background.blur))),
      depth: Math.max(0, Math.min(1, Number(patch.depth ?? this.state.background.depth))),
    };
    this.commit();
  }

  importBackground(kind: "image" | "video", path: string, name: string) {
    this.setBackground({ kind, path, name: name.trim() || path.split(/[\\/]/).pop() || "自定义背景", paused: false });
  }

  clearBackground() {
    this.setBackground({ kind: "none", path: "", name: "", paused: false });
  }
}

export const visualPreferences = new VisualPreferences();
