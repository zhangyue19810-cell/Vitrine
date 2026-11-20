import { CapsuleTabs } from "./capsule-tabs";
import { html, setHtml } from "./dom";
import type { ContentKind } from "./types";

/**
 * The strip of views under the brand: the home ring, then one tab per kind of online content. Every tab other than 首页
 * leaves the Möbius ring and regroups its archives into the single row of the download view.
 */

export type ViewId = "home" | ContentKind;

export const VIEW_TABS: { id: ViewId; label: string }[] = [
  { id: "home", label: "首页" },
  { id: "modpack", label: "整合包" },
  { id: "mod", label: "模组" },
  { id: "resourcepack", label: "资源包" },
  { id: "datapack", label: "数据包" },
  { id: "shader", label: "光影" },
];

const controllers = new WeakMap<HTMLElement, CapsuleTabs>();

export function renderTabs(root: HTMLElement, active: ViewId) {
  if (!root.querySelector(".view-tab")) {
    setHtml(
      root,
      html`${VIEW_TABS.map((tab) => html`<button class="view-tab" data-act="view-tab" data-view="${tab.id}" aria-current="false">${tab.label}</button>`)}`,
    );
    root.classList.add("view-tabs-capsule");
    controllers.set(root, new CapsuleTabs(root, { itemSelector: ".view-tab", activeSelector: '[aria-current="page"]' }));
  }
  for (const button of root.querySelectorAll<HTMLElement>(".view-tab")) {
    button.setAttribute("aria-current", button.dataset.view === active ? "page" : "false");
  }
  const selected = root.querySelector<HTMLElement>(`.view-tab[data-view="${active}"]`);
  controllers.get(root)?.setActive(selected ?? undefined, true);
}
