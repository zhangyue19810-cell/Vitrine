import { CapsuleTabs } from "./capsule-tabs";
import { html, setHtml } from "./dom";
import type { ContentKind } from "./types";

/**
 * The strip of views under the brand: the home ring, then one tab per kind of online content. Every tab other than 首页
 * leaves the Möbius ring and regroups its archives into the single row of the download view.
 */

export type ViewId = "home" | ContentKind | "music";

export const VIEW_TABS: { id: ViewId; label: string }[] = [
  { id: "home", label: "首页" },
  { id: "modpack", label: "整合包" },
  { id: "mod", label: "模组" },
  { id: "resourcepack", label: "资源包" },
  { id: "datapack", label: "数据包" },
  { id: "shader", label: "光影" },
  { id: "music", label: "音乐" },
];

const controllers = new WeakMap<HTMLElement, CapsuleTabs>();
const revealWired = new WeakSet<HTMLElement>();

/** Centre-top tabs: at rest only the active tab and a small peek survive; hover/focus opens the whole rack. */
function wireReveal(root: HTMLElement) {
  if (revealWired.has(root)) return;
  revealWired.add(root);
  root.classList.add("view-tabs-reveal");
  const coarse = matchMedia("(hover: none), (pointer: coarse)").matches;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const setOpen = (open: boolean) => {
    root.classList.toggle("view-tabs-open", open);
    root.dataset.expanded = String(open);
  };
  const open = () => {
    clearTimeout(closeTimer);
    setOpen(true);
  };
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (coarse || root.matches(":hover") || root.contains(document.activeElement)) return;
      setOpen(false);
    }, 150);
  };
  setOpen(coarse);
  root.addEventListener("pointerenter", open);
  root.addEventListener("pointerleave", closeSoon);
  root.addEventListener("focusin", open);
  root.addEventListener("focusout", closeSoon);
  // The strip is only a small current-tab pill at rest. Open it as the pointer
  // approaches the centre of the upper edge, before it has to hit a tiny target.
  const stage = root.closest<HTMLElement>("#stage");
  let proximityFrame = 0;
  let near = false;
  stage?.addEventListener("pointermove", (event) => {
    if (coarse || !stage) return;
    const box = root.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const within = event.clientY <= box.top + 150 && Math.abs(event.clientX - cx) <= Math.max(360, box.width / 2 + 220);
    if (within === near) return;
    near = within;
    cancelAnimationFrame(proximityFrame);
    proximityFrame = requestAnimationFrame(() => within ? open() : closeSoon());
  }, { passive: true });
  stage?.addEventListener("pointerleave", () => {
    near = false;
    closeSoon();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !root.classList.contains("view-tabs-open")) return;
    event.preventDefault();
    clearTimeout(closeTimer);
    setOpen(false);
    root.querySelector<HTMLElement>('.view-tab[aria-current="page"]')?.focus({ preventScroll: true });
  });
}

export function renderTabs(root: HTMLElement, active: ViewId) {
  if (!root.querySelector(".view-tab")) {
    setHtml(
      root,
      html`${VIEW_TABS.map((tab) => html`<button class="view-tab" data-act="view-tab" data-view="${tab.id}" aria-current="false">${tab.label}</button>`)}<span class="view-tabs-peek" aria-hidden="true">···</span>`,
    );
    root.classList.add("view-tabs-capsule");
    wireReveal(root);
    controllers.set(root, new CapsuleTabs(root, { itemSelector: ".view-tab", activeSelector: '[aria-current="page"]' }));
  }
  for (const button of root.querySelectorAll<HTMLElement>(".view-tab")) {
    button.setAttribute("aria-current", button.dataset.view === active ? "page" : "false");
  }
  const selected = root.querySelector<HTMLElement>(`.view-tab[data-view="${active}"]`);
  controllers.get(root)?.setActive(selected ?? undefined, true);
}
