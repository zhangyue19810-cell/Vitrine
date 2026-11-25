import { ringMaterialById, type RingMaterialId, type RingMaterialPreset } from "../ring-materials";

export interface VisualPreferencesState {
  ringMaterial: RingMaterialId;
}

const KEY = "vitrine.visuals.v1";
const DEFAULT_STATE: VisualPreferencesState = { ringMaterial: "black-gold" };

function read(): VisualPreferencesState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const value = JSON.parse(raw) as (Partial<VisualPreferencesState> & { background?: unknown }) | undefined;
    const state: VisualPreferencesState = { ringMaterial: ringMaterialById(String(value?.ringMaterial)).id };
    // The old wallpaper build stored a large background object in this same
    // key. Drop it the next time the old value is read.
    if (value?.background !== undefined) localStorage.setItem(KEY, JSON.stringify(state));
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** A tiny app-wide preference store for visual choices that live in CSS/WebGL rather than the core settings file. */
class VisualPreferences {
  private state = read();
  private readonly listeners = new Set<(state: VisualPreferencesState) => void>();

  get(): VisualPreferencesState {
    return { ...this.state };
  }

  get material(): RingMaterialPreset {
    return ringMaterialById(this.state.ringMaterial);
  }

  subscribe(listener: (state: VisualPreferencesState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setRingMaterial(id: RingMaterialId) {
    if (this.state.ringMaterial === id) return;
    this.state.ringMaterial = ringMaterialById(id).id;
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
}

export const visualPreferences = new VisualPreferences();
