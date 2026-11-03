import { PRODUCT } from "../brand";
import { escapeHtml } from "../html";

/**
 * The opening animation: the mark draws itself, two panes slide into the display case, the name rises letter by letter.
 * It is pure CSS (see styles/boot.css); this file only builds the markup, shows the real start-up step under it, and
 * lets the player skip. The splash never delays real work: it waits for the boot to finish, not the other way round.
 */

export interface Splash {
  /** Show what the launcher is doing right now and how far along it is (0–1). */
  status(text: string, progress: number): void;
  /** Resolves when the player asked to skip (click / key). */
  readonly skipped: Promise<void>;
  /** Fade out and remove. Resolves when the stage underneath is fully uncovered. */
  finish(): Promise<void>;
}

export function showSplash(root: HTMLElement, style: "full" | "short"): Splash {
  const letters = [...PRODUCT.name.toUpperCase()]
    .map((letter, index) => `<span style="animation-delay:${((style === "short" ? 0.05 : 0.95) + index * (style === "short" ? 0.02 : 0.07)).toFixed(2)}s">${escapeHtml(letter)}</span>`)
    .join("");
  const element = document.createElement("div");
  element.className = "splash";
  element.dataset.style = style;
  element.setAttribute("role", "status");
  element.setAttribute("aria-label", `${PRODUCT.name} 正在启动`);
  element.innerHTML = `
    <div class="splash-inner">
      <svg class="splash-mark" viewBox="0 0 256 256" aria-hidden="true">
        <rect class="frame" x="20" y="36" width="216" height="184" rx="38"/>
        <path class="pane-a" d="M54 66H100L140 152 128 190Z"/>
        <path class="pane-b" d="M202 66H156L116 152 128 190Z"/>
        <path class="strip" d="M96 205H160"/>
      </svg>
      <div class="splash-word"><b>${letters}</b><i>${escapeHtml(PRODUCT.nameCn)}</i></div>
      <div class="splash-status"><div class="splash-line"><i style="--p:.05"></i></div><div class="splash-text">STARTING</div></div>
    </div>
    <button class="splash-skip" type="button">点击或按任意键跳过</button>`;
  root.append(element);

  const bar = element.querySelector<HTMLElement>(".splash-line i")!;
  const label = element.querySelector<HTMLElement>(".splash-text")!;
  let resolveSkip!: () => void;
  const skipped = new Promise<void>((resolve) => (resolveSkip = resolve));
  const skip = () => resolveSkip();
  element.addEventListener("pointerdown", skip, { once: true });
  const onKey = () => skip();
  window.addEventListener("keydown", onKey, { once: true });

  return {
    skipped,
    status(text, progress) {
      label.textContent = text;
      bar.style.setProperty("--p", String(Math.max(0.04, Math.min(1, progress))));
    },
    finish() {
      window.removeEventListener("keydown", onKey);
      return new Promise<void>((resolve) => {
        element.dataset.leaving = "true";
        let done = false;
        const end = () => {
          if (done) return;
          done = true;
          element.remove();
          resolve();
        };
        element.addEventListener("transitionend", end, { once: true });
        setTimeout(end, 700);
      });
    },
  };
}
