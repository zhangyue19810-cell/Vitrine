/**
 * Small, delegated spring interactions for the whole interface.
 *
 * Structural transitions (pages, sheets, navigation, settings, startup) use
 * their own purpose-built springs. This module supplies the many tiny
 * interactions that otherwise become CSS duration tweens: hover lift, press
 * compression, focus, and the toggle knob. It runs only while the pointer is
 * interacting and writes individual CSS transform properties, so it composes
 * with the page-level translate/scale animation instead of fighting it.
 */

import { springElement, springNumber } from "./spring-ui";

const HOVER_SELECTOR = [
  ".btn",
  ".nav-button",
  ".view-tab",
  ".detail-tabs button",
  ".settings-nav button",
  ".tabs button",
  ".seg button",
  ".chip[role='button']",
  ".material-option",
  ".arrow-btn",
  ".back-button",
  ".window-controls button",
  ".splash-skip",
  ".dl-flat-card",
  ".dl-flat-more",
  ".card",
  ".proj",
  ".setting-toggle",
].join(",");

let installed = false;

function motionElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(HOVER_SELECTOR);
  if (!element) return null;
  if (element.closest(".glass-tuner, .no-spring, .reduce-motion")) return null;
  if (element.matches(":disabled, [aria-disabled='true'], input, textarea, select")) return null;
  return element;
}

function within(parent: HTMLElement, child: EventTarget | null) {
  return child instanceof Node && parent.contains(child);
}

function hover(el: HTMLElement, active: boolean) {
  // Buttons and cards rise just enough to acknowledge the pointer. The
  // overshoot is intentionally tiny: frequent UI feedback should stay quiet.
  void springElement(el, {
    fromY: active ? 0 : -1.6,
    toY: active ? -1.6 : 0,
    fromScale: active ? 1 : 1.008,
    toScale: active ? 1.008 : 1,
    fromOpacity: 1,
    toOpacity: 1,
    response: 0.28,
    dampingRatio: 0.9,
    force: 0.94,
  });
}

function press(el: HTMLElement) {
  void springElement(el, {
    fromY: -0.8,
    toY: -0.2,
    fromScale: 1.004,
    toScale: 0.972,
    fromOpacity: 1,
    toOpacity: 1,
    response: 0.22,
    dampingRatio: 0.88,
  });
}

function release(el: HTMLElement) {
  const stillHovered = el.matches(":hover");
  void springElement(el, {
    fromY: -0.2,
    toY: stillHovered ? -1.6 : 0,
    fromScale: 0.972,
    toScale: stillHovered ? 1.008 : 1,
    fromOpacity: 1,
    toOpacity: 1,
    response: 0.3,
    dampingRatio: 0.82,
  });
}

function toggleKnob(element: HTMLElement) {
  const next = element.getAttribute("aria-checked") === "true" ? 0 : 1;
  const current = Number.parseFloat(getComputedStyle(element).getPropertyValue("--toggle-knob")) || 0;
  void springNumber({
    from: current,
    to: next,
    response: 0.3,
    dampingRatio: 0.78,
    onUpdate: (value) => element.style.setProperty("--toggle-knob", String(value)),
  });
}

/** Install once, after the stage markup exists. */
export function installSpringMotion() {
  if (installed) return;
  installed = true;

  document.addEventListener("pointerover", (event) => {
    const el = motionElement(event.target);
    if (!el || within(el, event.relatedTarget)) return;
    hover(el, true);
  }, { passive: true });

  document.addEventListener("pointerout", (event) => {
    const el = motionElement(event.target);
    if (!el || within(el, event.relatedTarget)) return;
    hover(el, false);
  }, { passive: true });

  document.addEventListener("pointerdown", (event) => {
    const el = motionElement(event.target);
    if (el) press(el);
  }, { passive: true });

  const releasePointer = (event: PointerEvent) => {
    const el = motionElement(event.target);
    if (el) release(el);
  };
  document.addEventListener("pointerup", releasePointer, { passive: true });
  document.addEventListener("pointercancel", releasePointer, { passive: true });

  // Focus moves through the same spring as hover, so keyboard users get the
  // same continuous feedback without any duration-based CSS.
  document.addEventListener("focusin", (event) => {
    const el = motionElement(event.target);
    if (!el) return;
    void springElement(el, {
      fromY: 0,
      toY: -1.2,
      fromScale: 1,
      toScale: 1.006,
      fromOpacity: 1,
      toOpacity: 1,
      response: 0.3,
      dampingRatio: 0.92,
      force: 0.9,
    });
  });
  document.addEventListener("focusout", (event) => {
    const el = motionElement(event.target);
    if (!el || el.matches(":hover")) return;
    void springElement(el, {
      fromY: -1.2,
      toY: 0,
      fromScale: 1.006,
      toScale: 1,
      fromOpacity: 1,
      toOpacity: 1,
      response: 0.32,
      dampingRatio: 0.9,
      force: 0.9,
    });
  });

  // The toggle's pseudo-element is painted by CSS from this single custom
  // property; the property itself is integrated by the shared spring runner.
  document.addEventListener("click", (event) => {
    const toggle = (event.target as Element | null)?.closest<HTMLElement>(".toggle");
    if (!toggle || toggle.matches(":disabled, [aria-disabled='true']")) return;
    toggleKnob(toggle);
  }, true);
}
