import { el } from "./dom";

/**
 * A small pop-up menu anchored to a button. It is attached to the stage rather than to the row it belongs to, so list
 * rows (which clip their content for speed) cannot cut it off, and it is positioned in stage coordinates because the
 * stage is scaled to the window.
 */

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** A thin rule above this entry. */
  divider?: boolean;
}

let current: { close: (id?: string) => void } | undefined;

export function closeMenu() {
  current?.close();
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], options: { align?: "left" | "right" } = {}): Promise<string | undefined> {
  closeMenu();
  const stage = document.querySelector<HTMLElement>("#stage");
  if (!stage || !items.length) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const menu = el("div", { class: "menu", attrs: { role: "menu" } });
    menu.style.cssText = "position:absolute;z-index:45;right:auto;top:0;left:0;visibility:hidden";
    for (const item of items) {
      if (item.divider) menu.append(el("hr"));
      const button = el("button", { text: item.label, attrs: { type: "button", role: "menuitem", "data-id": item.id } });
      if (item.danger) button.classList.add("danger");
      if (item.disabled) button.disabled = true;
      menu.append(button);
    }
    stage.append(menu);

    const stageRect = stage.getBoundingClientRect();
    const scale = stageRect.width / stage.offsetWidth || 1;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const anchorLeft = (rect.left - stageRect.left) / scale;
    const anchorRight = (rect.right - stageRect.left) / scale;
    const anchorTop = (rect.top - stageRect.top) / scale;
    const anchorBottom = (rect.bottom - stageRect.top) / scale;
    let x = options.align === "left" ? anchorLeft : anchorRight - width;
    x = Math.max(8, Math.min(stage.offsetWidth - width - 8, x));
    let y = anchorBottom + 4;
    if (y + height > stage.offsetHeight - 8) y = Math.max(8, anchorTop - height - 4);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.visibility = "visible";
    anchor.setAttribute("aria-expanded", "true");

    let done = false;
    const close = (id?: string) => {
      if (done) return;
      done = true;
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("blur", onBlur);
      anchor.removeAttribute("aria-expanded");
      menu.remove();
      if (current?.close === close) current = undefined;
      resolve(id);
    };
    const onPointer = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) {
        // A click on the anchor itself should close, not reopen.
        if (anchor.contains(event.target as Node)) event.stopPropagation();
        close();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        anchor.focus({ preventScroll: true });
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
      }
    };
    const onScroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) close();
    };
    const onBlur = () => close();
    menu.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
      if (button && !button.disabled) close(button.dataset.id);
    });
    current = { close };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("wheel", onScroll, { capture: true, passive: true });
    window.addEventListener("blur", onBlur);
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  });
}
