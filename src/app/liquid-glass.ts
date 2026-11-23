/**
 * Pointer-reactive specular light for the liquid-glass surfaces.
 *
 * The DOM stays untouched for every element that is never hovered: a sheen
 * layer is created lazily on first entry. One delegated pointer listener and
 * one animation frame update the highlight, so a long mod list does not add
 * hundreds of listeners or permanent compositor layers.
 *
 * The highlight eases toward the pointer instead of snapping. That small
 * lag is what makes the surface feel like a viscous lens: the reflection
 * arrives a few milliseconds late, then settles without stepping at 144 Hz.
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
  ".stat",
  ".setting",
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
  ".together-room",
].join(",");

/** The time constant of the optical follow; smaller is snappier. */
const FOLLOW_MS = 52;

export function installLiquidGlass(root: HTMLElement): () => void {
  let active: HTMLElement | null = null;
  let targetX = 50;
  let targetY = 18;
  let currentX = 50;
  let currentY = 18;
  let frame = 0;
  let lastTime = 0;
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedQuery.matches;

  const paint = () => {
    if (!active) return;
    active.style.setProperty("--liquid-x", `${currentX.toFixed(2)}%`);
    active.style.setProperty("--liquid-y", `${currentY.toFixed(2)}%`);
    // A normal points out of the glass at the centre and leans toward the
    // pointer at the rim. CSS turns this into the moving specular angle.
    const nx = currentX / 50 - 1;
    const ny = currentY / 50 - 1;
    const radius = Math.min(1, Math.hypot(nx, ny));
    active.style.setProperty("--liquid-nx", nx.toFixed(3));
    active.style.setProperty("--liquid-ny", ny.toFixed(3));
    active.style.setProperty("--liquid-edge", radius.toFixed(3));
    active.style.setProperty("--liquid-centre", (1 - radius).toFixed(3));
    active.style.setProperty("--liquid-angle", `${(Math.atan2(ny, nx) * 180 / Math.PI + 360) % 360}deg`);
  };

  const clear = () => {
    active?.classList.remove("liquid-hot");
    active = null;
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  };

  const flush = (now: number) => {
    frame = 0;
    if (!active) return;
    const elapsed = lastTime ? Math.min(64, Math.max(1, now - lastTime)) : 16.667;
    lastTime = now;
    const follow = reduced ? 1 : 1 - Math.exp(-elapsed / FOLLOW_MS);
    currentX += (targetX - currentX) * follow;
    currentY += (targetY - currentY) * follow;
    const settled = Math.abs(targetX - currentX) < 0.03 && Math.abs(targetY - currentY) < 0.03;
    if (settled) {
      currentX = targetX;
      currentY = targetY;
    }
    paint();
    if (!settled) frame = requestAnimationFrame(flush);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const target = (event.target as Element | null)?.closest<HTMLElement>(LIQUID_TARGET);
    if (!target || !root.contains(target)) {
      clear();
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    targetX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    targetY = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));

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
      // The light is already where the pointer crossed the glass; only its
      // movement inside the surface gets the viscous follow.
      currentX = targetX;
      currentY = targetY;
      lastTime = 0;
      paint();
      return;
    }

    schedule();
  };

  const onLeave = () => clear();

  const onReducedChange = () => {
    reduced = reducedQuery.matches;
    if (reduced && active) {
      currentX = targetX;
      currentY = targetY;
      paint();
    }
  };

  root.addEventListener("pointermove", onPointerMove, { passive: true });
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("pointercancel", onLeave);
  window.addEventListener("blur", onLeave);
  reducedQuery.addEventListener("change", onReducedChange);
  return () => {
    clear();
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("pointercancel", onLeave);
    window.removeEventListener("blur", onLeave);
    reducedQuery.removeEventListener("change", onReducedChange);
  };
}
