/**
 * A small, dependency-free spring indicator for tab groups.
 *
 * The capsule is one element behind the buttons. On selection it travels to
 * the new button, stretches along the direction of travel while it has speed,
 * and settles with a light overshoot. It only runs requestAnimationFrame while
 * the spring is alive; reduced-motion users get an immediate, stable capsule.
 */

import { capsuleSpringStep } from "./capsule-spring";

export type CapsuleAxis = "x" | "y";

export interface CapsuleTabsOptions {
  axis?: CapsuleAxis;
  /** Buttons inside the tab bar. */
  itemSelector?: string;
  /** Which item is currently selected. */
  activeSelector?: string;
}

interface CapsuleGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ZERO: CapsuleGeometry = { x: 0, y: 0, width: 0, height: 0 };
const MOTION_KEYS = ["x", "y", "width", "height"] as const;
const POSITION_SPRING = 0.26;
const POSITION_DAMPING = 0.72;
const SIZE_SPRING = 0.2;
const SIZE_DAMPING = 0.69;

export class CapsuleTabs {
  private readonly capsule: HTMLSpanElement;
  private readonly itemSelector: string;
  private readonly activeSelector: string;
  private readonly axis: CapsuleAxis;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  private items: HTMLElement[] = [];
  private active?: HTMLElement;
  private current: CapsuleGeometry = { ...ZERO };
  private target: CapsuleGeometry = { ...ZERO };
  private velocity: CapsuleGeometry = { ...ZERO };
  private frame = 0;
  private lastTime = 0;
  private hasPosition = false;
  private direction: 1 | -1 = 1;
  private destroyed = false;
  private readonly onReducedChange = () => {
    if (this.reduced()) this.snap();
  };

  constructor(
    private readonly root: HTMLElement,
    options: CapsuleTabsOptions = {},
  ) {
    this.axis = options.axis ?? "x";
    this.itemSelector = options.itemSelector ?? "button";
    this.activeSelector = options.activeSelector ?? '[aria-current="page"], [aria-selected="true"]';
    this.root.classList.add("capsule-tabs");
    this.root.dataset.capsuleAxis = this.axis;

    this.capsule = document.createElement("span");
    this.capsule.className = "capsule-indicator";
    this.capsule.setAttribute("aria-hidden", "true");
    this.capsule.dataset.moving = "false";
    this.root.prepend(this.capsule);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.destroyed && this.active) this.refresh(true);
    });
    this.resizeObserver.observe(this.root);
    this.reducedQuery.addEventListener("change", this.onReducedChange);
    void document.fonts?.ready.then(() => {
      if (!this.destroyed) this.refresh(false);
    });
    this.refresh(false);
  }

  /** Re-read the buttons and snap to the active one. Call after replacing the bar markup. */
  refresh(animate = false) {
    if (this.destroyed) return;
    if (!this.capsule.isConnected) this.root.prepend(this.capsule);
    this.items = [...this.root.querySelectorAll<HTMLElement>(this.itemSelector)];
    const next = this.items.find((item) => item.matches(this.activeSelector));
    if (next) this.setActive(next, animate);
  }

  /** Move the capsule to `item`. `animate` is ignored for the first placement and reduced motion. */
  setActive(item: HTMLElement | undefined, animate = true) {
    if (this.destroyed || !item || item === this.capsule || !this.root.contains(item)) return;
    const next = this.measure(item);
    const unchanged = item === this.active && Object.keys(next).every((key) => Math.abs(next[key as keyof CapsuleGeometry] - this.target[key as keyof CapsuleGeometry]) < 0.5);
    if (unchanged) return;
    if (!this.hasPosition || !animate || this.reduced()) {
      this.active = item;
      this.current = { ...next };
      this.target = { ...next };
      this.velocity = { ...ZERO };
      this.stop();
      this.hasPosition = true;
      this.apply();
      return;
    }
    if (!this.active || !this.active.isConnected) {
      this.active = item;
      this.current = { ...next };
      this.target = { ...next };
      this.velocity = { ...ZERO };
      this.hasPosition = true;
      this.stop();
      this.apply();
      return;
    }
    this.active = item;
    const previousX = this.current.x;
    const previousY = this.current.y;
    this.target = next;
    this.direction = this.axis === "y"
      ? next.y + next.height / 2 >= previousY + this.current.height / 2 ? 1 : -1
      : next.x + next.width / 2 >= previousX + this.current.width / 2 ? 1 : -1;
    this.start();
  }

  private measure(item: HTMLElement): CapsuleGeometry {
    return {
      x: item.offsetLeft,
      y: item.offsetTop,
      width: item.offsetWidth,
      height: item.offsetHeight,
    };
  }

  private reduced() {
    return this.reducedQuery.matches || Boolean(this.root.closest(".reduce-motion"));
  }

  private snap() {
    if (!this.active || !this.active.isConnected) return;
    this.target = this.measure(this.active);
    this.current = { ...this.target };
    this.velocity = { ...ZERO };
    this.stop();
    this.hasPosition = true;
    this.apply();
  }

  private start() {
    if (this.frame) return;
    this.lastTime = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastTime = 0;
    this.capsule.dataset.moving = "false";
  }

  private readonly tick = (time: number) => {
    if (this.destroyed) return;
    // Integrate in fixed 60 Hz-ish substeps. A low frame rate must not turn a
    // 300 ms gesture into a two-second glide on software renderers.
    let remaining = this.lastTime ? Math.min(120, Math.max(1, time - this.lastTime)) / 16.667 : 1;
    this.lastTime = time;
    while (remaining > 0) {
      const dt = Math.min(1, remaining);
      for (const key of MOTION_KEYS) {
        const size = key === "width" || key === "height";
        const step = capsuleSpringStep(
          this.current[key],
          this.velocity[key],
          this.target[key],
          size ? SIZE_SPRING : POSITION_SPRING,
          size ? SIZE_DAMPING : POSITION_DAMPING,
          dt,
        );
        this.current[key] = step.value;
        this.velocity[key] = step.velocity;
      }
      remaining -= dt;
    }
    const moving = MOTION_KEYS.some((key) => Math.abs(this.current[key] - this.target[key]) > 0.18 || Math.abs(this.velocity[key]) > 0.018);
    if (!moving) {
      this.current = { ...this.target };
      this.velocity = { ...ZERO };
      this.frame = 0;
      this.lastTime = 0;
      this.apply();
      return;
    }
    this.apply();
    this.frame = requestAnimationFrame(this.tick);
  };

  private apply() {
    const p = this.current;
    const speed = this.axis === "x" ? Math.abs(this.velocity.x) : Math.abs(this.velocity.y);
    const size = this.axis === "x" ? p.width : p.height;
    const stretch = 1 + Math.min(0.16, (speed / Math.max(1, size)) * 0.62);
    const origin = this.axis === "x"
      ? `${this.direction > 0 ? "left" : "right"} center`
      : `${this.direction > 0 ? "top" : "bottom"} center`;
    this.capsule.style.width = `${Math.max(0, p.width)}px`;
    this.capsule.style.height = `${Math.max(0, p.height)}px`;
    this.capsule.style.transformOrigin = origin;
    this.capsule.style.transform = this.axis === "x"
      ? `translate3d(${p.x}px, ${p.y}px, 0) scaleX(${stretch})`
      : `translate3d(${p.x}px, ${p.y}px, 0) scaleY(${stretch})`;
    this.capsule.dataset.moving = speed > 0.03 ? "true" : "false";
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.resizeObserver.disconnect();
    this.reducedQuery.removeEventListener("change", this.onReducedChange);
    this.capsule.remove();
    this.root.classList.remove("capsule-tabs");
    delete this.root.dataset.capsuleAxis;
  }
}
