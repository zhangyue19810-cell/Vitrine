import { CARD_SIZES, type CardSize } from "../archive-stage";
import type { PlateGroup, PlateSpec } from "../rail/model";
import type { RailBus } from "./rail-bus";
import type { ViewId } from "./tabs";

/**
 * The archive-size switch, as a plate of the control rail. The view tabs themselves stay our HTML glass
 * capsule; the 2026-11-22 music package's rail is used for the smaller stage controls and for the music
 * source / search / back plates (owned by MusicView), not to replace the launcher's navigation.
 */

const PART = "view";
const SIZE_OPTIONS: { size: CardSize; label: string }[] = [
  { size: "small", label: "小" },
  { size: "medium", label: "中" },
  { size: "large", label: "大" },
];
const TABS_OFFSET = 20;
const TABS_MARGIN = 72;
const TAB_HEIGHT = 40;

export interface ViewControlsHandlers {
  show(view: ViewId): void;
  size(size: CardSize): void;
}

export class ViewControls {
  private size: CardSize = "medium";
  private enabled = false;

  constructor(
    private readonly bus: RailBus,
    private readonly handlers: ViewControlsHandlers,
  ) {
    bus.set(PART, [], {
      press: (id, cell) => {
        if (id !== "size") return;
        const choice = SIZE_OPTIONS[cell ?? -1];
        if (choice) this.handlers.size(choice.size);
      },
    });
  }

  /** Show the plate (a 3D scene exists) or take it away (the HTML controls do the job). */
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.render();
  }

  /** Kept for the app's existing calls; the navigation capsule is HTML, not a rail plate. */
  setActive(_view: ViewId) {}

  setSize(size: CardSize) {
    if (this.size === size) return;
    this.size = size;
    this.render();
  }

  private render() {
    if (!this.enabled) return this.bus.clear(PART);
    const size: PlateSpec = {
      id: "size",
      kind: "segments",
      label: "档案",
      options: SIZE_OPTIONS.map((option) => option.label),
      selected: Object.keys(CARD_SIZES).indexOf(this.size),
      width: 148,
    };
    const groups: PlateGroup[] = [
      { id: "size", dock: "top-left", offset: TABS_OFFSET, margin: TABS_MARGIN + TAB_HEIGHT + 12, plates: [size] },
    ];
    this.bus.set(PART, groups);
  }
}
