/**
 * Pointer-reactive light for Vitrine's liquid-glass surfaces.
 *
 * One delegated listener feeds a single animation frame: the specular
 * highlight follows the pointer with a short optical delay, large panels tilt
 * a few tenths of a degree in perspective, and a gently travelling gradient
 * outlines the most important glass surfaces.
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
  ".dl-flat-card",
  ".notice",
  ".problem",
  ".stat",
  ".setting",
  ".mod-row",
  ".mod-update-row",
  ".mod-problem-trigger",
  ".mod-problem-popover",
  ".material-option",
  ".custom-download-status",
  ".hud-capsule",
  ".hud-queue",
  ".item",
  ".empty",
  ".logview",
  ".settings",
  ".settings-nav",
  ".seg",
  ".tabs",
  ".btn",
  ".nav-button",
  ".view-tab",
  ".chip",
  ".toggle",
  ".menu",
  ".together-room",
].join(",");

/** Only broad, stable surfaces tilt; controls keep their familiar geometry. */
const TILT_TARGET = ".callout,.detail-panel,.dl-bar,.card,.dl-flat-card,.mod-row,.stat,.setting,.notice,.dialog,.menu";

/** The travelling gradient border is deliberately limited to framed surfaces. */
const EDGE_TARGET = [
  ".callout",
  ".detail-panel",
  ".dl-bar",
  ".sheet",
  ".dialog",
  ".menu",
  ".system-nav",
  ".view-tabs",
  ".card",
  ".dl-flat-card",
  ".notice",
  ".problem",
  ".mod-row",
  ".mod-update-row",
  ".stat",
  ".setting",
  ".material-option",
  ".custom-download-status",
  ".mod-problem-popover",
  ".toast",
  ".together-room",
  ".hud-capsule",
  ".hud-queue",
  ".btn",
  ".nav-button",
  ".view-tab",
  ".seg",
  ".seg button",
  ".toggle",
].join(",");

const EDGE_ALWAYS = ".callout,.detail-panel,.dl-bar,.sheet,.dialog,.menu,.hud-capsule";

/** Surfaces that get the centre-clear radial blur layer in addition to their glass fill. */
const LENS_TARGET = [
  ".btn",
  ".callout",
  ".detail-panel",
  ".dialog",
  ".menu",
  ".card",
  ".dl-flat-card",
  ".material-option",
  ".setting",
  ".hud-capsule",
  ".hud-queue",
  ".system-nav",
  ".view-tabs",
].join(",");

/** Capsule controls get the circular water-fill reveal and a lighter light pass. */
const DROP_TARGET = ".btn,.nav-button,.view-tab,.seg,.toggle,.system-nav,.view-tabs,.hud-capsule";
const CONTROL_TARGET = ".btn,.nav-button,.view-tab,.seg,.seg button,.toggle";

/** The time constant of the optical follow; smaller is snappier. */
const FOLLOW_MS = 52;

export function installLiquidGlass(root: HTMLElement): () => void {
  let active: HTMLElement | null = null;
  let tiltPanel: HTMLElement | null = null;
  let targetX = 50;
  let targetY = 18;
  let currentX = 50;
  let currentY = 18;
  let targetTiltX = 0;
  let targetTiltY = 0;
  let currentTiltX = 0;
  let currentTiltY = 0;
  let frame = 0;
  let lastTime = 0;
  let edgeSeed = 0;
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedQuery.matches;

  const paintSheen = () => {
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

  const paintTilt = () => {
    if (!tiltPanel) return;
    tiltPanel.style.setProperty("--liquid-rot-x", `${currentTiltX.toFixed(2)}deg`);
    tiltPanel.style.setProperty("--liquid-rot-y", `${currentTiltY.toFixed(2)}deg`);
  };

  const clearSheen = () => {
    active?.classList.remove("liquid-hot");
    active = null;
  };

  const clearTilt = (reset = true) => {
    if (!tiltPanel) return;
    tiltPanel.classList.remove("liquid-tilt-live");
    if (reset) {
      tiltPanel.style.setProperty("--liquid-rot-x", "0deg");
      tiltPanel.style.setProperty("--liquid-rot-y", "0deg");
    }
    tiltPanel = null;
  };

  const ensureEdge = (target: HTMLElement) => {
    if (!target.matches(EDGE_TARGET)) return;
    if (getComputedStyle(target).position === "static") target.style.position = "relative";
    const seed = edgeSeed++;
    if (!target.querySelector(":scope > .liquid-flow")) {
      const flow = document.createElement("span");
      flow.className = "liquid-flow";
      flow.setAttribute("aria-hidden", "true");
      flow.style.setProperty("--flow-delay", `${-(seed % 11) * 1.15}s`);
      target.append(flow);
    }
    if (target.matches(DROP_TARGET) && !target.querySelector(":scope > .liquid-drop")) {
      const drop = document.createElement("span");
      drop.className = "liquid-drop";
      drop.setAttribute("aria-hidden", "true");
      target.append(drop);
      target.classList.add("liquid-drop-host");
    }
    if (target.matches(CONTROL_TARGET)) target.classList.add("liquid-light-control");
    if (target.matches(LENS_TARGET) && !target.querySelector(":scope > .liquid-lens")) {
      const lens = document.createElement("span");
      lens.className = "liquid-lens";
      lens.setAttribute("aria-hidden", "true");
      target.prepend(lens);
    }
    if (!target.querySelector(":scope > .liquid-edge")) {
      const edge = document.createElement("span");
      edge.className = "liquid-edge";
      edge.setAttribute("aria-hidden", "true");
      edge.style.setProperty("--edge-delay", `${-(seed % 8) * 0.85}s`);
      target.append(edge);
    }
    target.classList.add("liquid-edge-host");
    if (target.matches(EDGE_ALWAYS)) target.classList.add("liquid-edge-always");
  };

  const scanEdges = (from: ParentNode) => {
    if (from instanceof Element) ensureEdge(from as HTMLElement);
    for (const element of from.querySelectorAll<HTMLElement>(EDGE_TARGET)) ensureEdge(element);
  };
  scanEdges(root);
  const edgeQueue = new Set<Element>();
  let edgeFrame = 0;
  const flushEdges = () => {
    edgeFrame = 0;
    for (const node of edgeQueue) scanEdges(node);
    edgeQueue.clear();
  };
  const edgeObserver = new MutationObserver((records) => {
    for (const record of records) {
      // A surface that is populated by replacing innerHTML keeps its class but
      // loses the light spans. Re-scan the container as well as its new
      // children so the travelling rim and water bead are restored.
      if (record.target instanceof Element) edgeQueue.add(record.target);
      for (const node of record.addedNodes) if (node instanceof Element) edgeQueue.add(node);
    }
    if (edgeQueue.size && !edgeFrame) edgeFrame = requestAnimationFrame(flushEdges);
  });
  edgeObserver.observe(root, { childList: true, subtree: true });

  const flush = (now: number) => {
    frame = 0;
    if (!active && !tiltPanel) return;
    const elapsed = lastTime ? Math.min(64, Math.max(1, now - lastTime)) : 16.667;
    lastTime = now;
    const follow = reduced ? 1 : 1 - Math.exp(-elapsed / FOLLOW_MS);
    let moving = false;
    if (active) {
      currentX += (targetX - currentX) * follow;
      currentY += (targetY - currentY) * follow;
      const settled = Math.abs(targetX - currentX) < 0.03 && Math.abs(targetY - currentY) < 0.03;
      if (settled) {
        currentX = targetX;
        currentY = targetY;
      }
      paintSheen();
      moving ||= !settled;
    }
    if (tiltPanel) {
      currentTiltX += (targetTiltX - currentTiltX) * follow;
      currentTiltY += (targetTiltY - currentTiltY) * follow;
      const settled = Math.abs(targetTiltX - currentTiltX) < 0.01 && Math.abs(targetTiltY - currentTiltY) < 0.01;
      if (settled) {
        currentTiltX = targetTiltX;
        currentTiltY = targetTiltY;
      }
      paintTilt();
      moving ||= !settled;
    }
    if (moving) frame = requestAnimationFrame(flush);
    else lastTime = 0;
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const resolver = (selector: string) => (event.target as Element | null)?.closest<HTMLElement>(selector) ?? null;

    const dropTarget = resolver(DROP_TARGET);
    if (dropTarget && root.contains(dropTarget)) {
      const rect = dropTarget.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        dropTarget.style.setProperty("--drop-x", `${Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)).toFixed(2)}%`);
        dropTarget.style.setProperty("--drop-y", `${Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)).toFixed(2)}%`);
      }
    }

    const target = resolver(LIQUID_TARGET);
    if (target && root.contains(target)) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        targetX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
        targetY = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
      }
      if (target !== active) {
        clearSheen();
        active = target;
        target.classList.add("liquid-target", "liquid-hot");
        if (getComputedStyle(target).position === "static") target.style.position = "relative";
        if (!target.querySelector(":scope > .liquid-sheen")) {
          const sheen = document.createElement("span");
          sheen.className = "liquid-sheen";
          sheen.setAttribute("aria-hidden", "true");
          target.prepend(sheen);
        }
        currentX = targetX;
        currentY = targetY;
        lastTime = 0;
        paintSheen();
      }
    } else {
      clearSheen();
    }

    const panel = resolver(TILT_TARGET);
    if (panel && root.contains(panel)) {
      const rect = panel.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
        const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
        const broad = panel.matches(".callout,.detail-panel,.dl-bar,.dialog,.menu");
        targetTiltX = -ny * (broad ? 2.05 : 3.4);
        targetTiltY = nx * (broad ? 2.45 : 4.1);
      }
      if (panel !== tiltPanel) {
        clearTilt(true);
        tiltPanel = panel;
        if (getComputedStyle(panel).position === "static") panel.style.position = "relative";
        panel.classList.add("liquid-tiltable", "liquid-tilt-live");
        currentTiltX = targetTiltX;
        currentTiltY = targetTiltY;
        paintTilt();
      }
    } else {
      clearTilt(true);
    }

    if (active || tiltPanel) schedule();
  };

  const onLeave = () => {
    clearSheen();
    clearTilt(true);
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  };

  const onReducedChange = () => {
    reduced = reducedQuery.matches;
    if (!reduced) return;
    currentX = targetX;
    currentY = targetY;
    currentTiltX = targetTiltX;
    currentTiltY = targetTiltY;
    paintSheen();
    paintTilt();
  };

  root.addEventListener("pointermove", onPointerMove, { passive: true });
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("pointercancel", onLeave);
  window.addEventListener("blur", onLeave);
  reducedQuery.addEventListener("change", onReducedChange);
  return () => {
    edgeObserver.disconnect();
    cancelAnimationFrame(edgeFrame);
    onLeave();
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("pointercancel", onLeave);
    window.removeEventListener("blur", onLeave);
    reducedQuery.removeEventListener("change", onReducedChange);
  };
}
