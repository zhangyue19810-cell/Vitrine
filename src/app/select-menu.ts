import { openMenu } from "./menu";

/**
 * Replace native `<select>` popups with the launcher's own glass menu.
 *
 * In Electron a native select is a separate OS popup. In a frameless
 * transparent window that path can flash and hand focus to Explorer instead
 * of staying inside the launcher. This delegated adapter keeps every existing
 * `<select class="select">` working (including dynamically created ones) but
 * never asks Chromium to open its native dropdown.
 */
export function installSelectMenus(): () => void {
  let suppressClickUntil = 0;

  const selectAt = (target: EventTarget | null): HTMLSelectElement | null => {
    const element = target instanceof Element ? target.closest<HTMLSelectElement>("select.select") : null;
    return element && !element.disabled ? element : null;
  };

  const open = (select: HTMLSelectElement) => {
    if (select.disabled || !select.options.length) return;
    select.focus({ preventScroll: true });
    const selected = select.selectedIndex;
    const items = [...select.options].map((option, index) => ({
      id: String(index),
      label: `${index === selected ? "✓ " : ""}${option.label || option.text}`,
      disabled: option.disabled,
    }));
    void openMenu(select, items, { align: "left" }).then((id) => {
      if (id === undefined) return;
      const option = select.options[Number(id)];
      if (!option || option.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      select.focus({ preventScroll: true });
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    const select = selectAt(event.target);
    if (!select) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickUntil = performance.now() + 450;
    open(select);
  };

  const onClick = (event: MouseEvent) => {
    if (!selectAt(event.target) || performance.now() > suppressClickUntil) return;
    // Chromium would still dispatch the click after pointerdown; keep it from
    // reaching the native select/default action.
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const select = event.target instanceof HTMLSelectElement && event.target.matches("select.select") && !event.target.disabled
      ? event.target
      : null;
    if (!select) return;
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    open(select);
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
