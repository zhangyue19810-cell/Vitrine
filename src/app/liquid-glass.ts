/**
 * Pointer-reactive specular light for the liquid-glass surfaces.
 *
 * The DOM stays untouched for every element that is never hovered: a sheen
 * layer is created lazily on first entry. One delegated pointer listener and
 * one animation frame update the highlight, so a long mod list does not add
 * hundreds of listeners or permanent compositor layers.
 */

const LIQUID_TARGET = [
  ".system-nav",
  ".view-tabs",
  ".callout",
  ".detail-panel",
  ".dl-bar",
  ".sheet",
  ".dialog",
  ".card",
  ".notice",
  ".problem",
  ".mod-row",
  ".mod-update-row",
  ".mod-problem-trigger",
  ".mod-problem-popover",
  ".item",
  ".empty",
  ".logview",
  ".settings",
  ".settings-nav",
  ".seg",
  ".tabs",
  ".btn",
  ".nav-button",
  ".chip",
  ".toggle",
  ".menu",
].join(",");

export function installLiquidGlass(root: HTMLElement): () => void {
  let active: HTMLElement | null = null;
  let rx = 50;
  let ry = 18;
  let frame = 0;

  const clear = () => {
    active?.classList.remove("liquid-hot");
    active = null;
  };

  const flush = () => {
    frame = 0;
    if (!active) return;
    active.style.setProperty("--liquid-x", `${rx.toFixed(2)}%`);
    active.style.setProperty("--liquid-y", `${ry.toFixed(2)}%`);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const target = (event.target as Element | null)?.closest<HTMLElement>(LIQUID_TARGET);
    if (!target || !root.contains(target)) {
      clear();
      return;
    }
    if (target !== active) {
      clear();
      active = target;
      target.classList.add("liquid-target", "liquid-hot");
      if (getComputedStyle(target).position === "static") target.style.position = "relative";
      if (!target.querySelector(":scope > .liquid-sheen")) {
        const sheen = document.createElement("span");
        sheen.className = "liquid-sheen";
        sheen.setAttribute("aria-hidden", "true");
        target.prepend(sheen);
      }
    }
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      rx = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
      ry = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
      // SDF-style normal hint: centre points straight out; the rim leans
      // towards the pointer. CSS turns this into the moving specular angle.
      const nx = (rx / 50) - 1;
      const ny = (ry / 50) - 1;
      target.style.setProperty("--liquid-nx", nx.toFixed(3));
      target.style.setProperty("--liquid-ny", ny.toFixed(3));
      target.style.setProperty("--liquid-edge", Math.min(1, Math.max(Math.abs(nx), Math.abs(ny))).toFixed(3));
      target.style.setProperty("--liquid-angle", `${(Math.atan2(ny, nx) * 180 / Math.PI + 360) % 360}deg`);
    }
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const onLeave = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    clear();
  };

  root.addEventListener("pointermove", onPointerMove, { passive: true });
  root.addEventListener("pointerleave", onLeave);
  window.addEventListener("blur", onLeave);
  return () => {
    cancelAnimationFrame(frame);
    clear();
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
  };
}
