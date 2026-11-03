/**
 * Keyboard map. Arrow keys move over the shelf, Enter launches, Space opens the instance page, `/` or Ctrl+K searches.
 * Nothing here fires while a text field has the focus, an overlay is open (those handle their own keys) or an
 * input method is composing text.
 */

export interface ShortcutHandlers {
  mode(): "archive" | "detail";
  /** A sheet, dialog, launch screen or the splash is in front. */
  blocked(): boolean;
  stepFile(direction: number): void;
  stepLane(direction: number): void;
  launch(): void;
  open(): void;
  back(): void;
  search(): void;
  settings(): void;
  downloads(): void;
  create(): void;
  tab(index: number): void;
}

const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
};

export function installShortcuts(handlers: ShortcutHandlers): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const command = event.ctrlKey || event.metaKey;
    // Chords work from anywhere on the page except over an overlay.
    if (command && !handlers.blocked()) {
      if (event.key.toLowerCase() === "k") return void (event.preventDefault(), handlers.search());
      if (event.key === ",") return void (event.preventDefault(), handlers.settings());
    }
    if (handlers.blocked() || isTyping(event.target) || event.altKey || command) return;

    if (handlers.mode() === "detail") {
      if (event.key === "Escape") return void (event.preventDefault(), handlers.back());
      if (/^[1-9]$/.test(event.key)) return void handlers.tab(Number(event.key) - 1);
      return;
    }
    // A focused button handles Enter / Space itself; only take them when nothing specific has the focus.
    const onControl = (event.target as HTMLElement | null)?.closest?.("button, a, [role=tab], select, summary");
    switch (event.key) {
      case "ArrowUp":
        return void (event.preventDefault(), handlers.stepFile(-1));
      case "ArrowDown":
        return void (event.preventDefault(), handlers.stepFile(1));
      case "ArrowLeft":
        return void (event.preventDefault(), handlers.stepLane(-1));
      case "ArrowRight":
        return void (event.preventDefault(), handlers.stepLane(1));
      case "Enter":
        if (!onControl) return void (event.preventDefault(), handlers.launch());
        return;
      case " ":
        if (!onControl) return void (event.preventDefault(), handlers.open());
        return;
      case "/":
        return void (event.preventDefault(), handlers.search());
      case "d":
      case "D":
        return void handlers.downloads();
      case "n":
      case "N":
        return void handlers.create();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
