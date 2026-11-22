import { CARD_SIZES, type CardSize } from "../archive-stage";
import type { PlateGroup, PlateSpec } from "../rail/model";
import type { RailBus } from "./rail-bus";
import { VIEW_TABS, type ViewId } from "./tabs";

/**
 * The view tabs and the archive-size switch, as plates of the control rail: the strip that used to be HTML under the brand is
 * now index tabs standing in the 3D picture (the one that is on stands a little taller), and under it one plate with three
 * cells for the size of the archives. The plain HTML strip stays as the fallback when there is no 3D scene.
 */

const PART = "view";
const SIZE_OPTIONS: { size: CardSize; label: string }[] = [
  { size: "small", label: "小" },
  { size: "medium", label: "中" },
  { size: "large", label: "大" },
];
/** Two-character labels take a narrower tab than three-character ones. */
const widthOf = (label: string) => (label.length >= 3 ? 90 : 74);
/** Where the strip hangs: the same place as the HTML one (46 px from the left, 98 px from the top). */
const TABS_OFFSET = 20;
const TABS_MARGIN = 72;
const TAB_HEIGHT = 40;

export interface ViewControlsHandlers {
  show(view: ViewId): void;
  size(size: CardSize): void;
}

export class ViewControls {
  private active: ViewId = "home";
  private size: CardSize = "medium";
  private enabled = false;

  constructor(
    private readonly bus: RailBus,
    private readonly handlers: ViewControlsHandlers,
  ) {
    bus.set(PART, [], {
      press: (id, cell) => {
        if (id === "size") {
          const choice = SIZE_OPTIONS[cell ?? -1];
          if (choice) this.handlers.size(choice.size);
        } else if (VIEW_TABS.some((tab) => tab.id === id)) this.handlers.show(id as ViewId);
      },
    });
  }

  /** Show the plates (a 3D scene exists) or take them away (the HTML strip does the job). */
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.render();
  }

  setActive(view: ViewId) {
    if (this.active === view) return;
    this.active = view;
    this.render();
  }

  setSize(size: CardSize) {
    if (this.size === size) return;
    this.size = size;
    this.render();
  }

  private render() {
    if (!this.enabled) return this.bus.clear(PART);
    const tabs: PlateSpec[] = VIEW_TABS.map((tab) => ({ id: tab.id, kind: "tab", label: tab.label, active: tab.id === this.active, width: widthOf(tab.label), lift: tab.id === this.active ? 6 : 0 }));
    const size: PlateSpec = { id: "size", kind: "segments", label: "档案", options: SIZE_OPTIONS.map((option) => option.label), selected: Object.keys(CARD_SIZES).indexOf(this.size), width: 148 };
    const groups: PlateGroup[] = [
      { id: "tabs", dock: "top-left", offset: TABS_OFFSET, margin: TABS_MARGIN, gap: 6, plates: tabs },
      { id: "size", dock: "top-left", offset: TABS_OFFSET, margin: TABS_MARGIN + TAB_HEIGHT + 12, plates: [size] },
    ];
    this.bus.set(PART, groups);
  }
}
