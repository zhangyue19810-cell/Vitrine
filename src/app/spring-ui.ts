/**
 * Small rAF spring runner for the interface. Every transform is integrated
 * from stiffness and damping ratio per frame; there are no CSS keyframe
 * timelines or fixed animation durations.
 */

export interface SpringOptions {
  fromX?: number;
  fromY?: number;
  fromOpacity?: number;
  toOpacity?: number;
  stiffness?: number;
  dampingRatio?: number;
  velocityX?: number;
  velocityY?: number;
  delay?: number;
  force?: number;
}

interface RunningSpring {
  raf: number;
  restore: () => void;
}

const running = new WeakMap<HTMLElement, RunningSpring>();
let lastPointer = { x: 0, y: 0, t: 0 };
let pointerForce = 1;

window.addEventListener("pointermove", (event) => {
  const now = performance.now();
  if (lastPointer.t > 0 && now - lastPointer.t < 140) {
    const distance = Math.hypot(event.clientX - lastPointer.x, event.clientY - lastPointer.y);
    const speed = distance / Math.max(1, now - lastPointer.t);
    pointerForce = Math.max(0.78, Math.min(1.85, 0.92 + speed * 0.55));
  }
  lastPointer = { x: event.clientX, y: event.clientY, t: now };
}, { passive: true });

/** A click/drag imparts more initial velocity to the spring. */
export function currentSpringForce(): number {
  return pointerForce;
}

function cancelSpring(element: HTMLElement) {
  const active = running.get(element);
  if (!active) return;
  cancelAnimationFrame(active.raf);
  active.restore();
  running.delete(element);
}

export function springElement(element: HTMLElement, options: SpringOptions = {}): Promise<void> {
  cancelSpring(element);
  const previous = {
    translate: element.style.getPropertyValue("translate"),
    opacity: element.style.opacity,
    willChange: element.style.willChange,
  };
  const restore = () => {
    element.style.setProperty("translate", previous.translate);
    element.style.opacity = previous.opacity;
    element.style.willChange = previous.willChange;
  };
  const fromX = options.fromX ?? 0;
  const fromY = options.fromY ?? 24;
  const fromOpacity = options.fromOpacity ?? 0;
  const toOpacity = options.toOpacity ?? 1;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || Boolean(element.closest(".reduce-motion"));
  if (reduced) {
    element.style.setProperty("translate", "0px 0px");
    if (toOpacity >= 0.999) restore();
    else element.style.opacity = String(toOpacity);
    return Promise.resolve();
  }
  const stiffness = Math.max(20, options.stiffness ?? 165);
  const dampingRatio = Math.max(0.2, Math.min(1.2, options.dampingRatio ?? 0.76));
  const force = Math.max(0.2, Math.min(2.5, options.force ?? 1));
  const damping = 2 * dampingRatio * Math.sqrt(stiffness);
  const delay = Math.max(0, options.delay ?? 0);
  let x = fromX;
  let y = fromY;
  let vx = (options.velocityX ?? 0) * force;
  let vy = (options.velocityY ?? 0) * force;
  let last = 0;
  let started = false;
  element.style.setProperty("translate", `${x}px ${y}px`);
  element.style.opacity = String(fromOpacity);
  element.style.willChange = "translate, opacity";
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (!started) {
        if (now - startedAt < delay) {
          const raf = requestAnimationFrame(frame);
          running.set(element, { raf, restore });
          return;
        }
        started = true;
        last = now;
      }
      const elapsed = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      let remaining = elapsed;
      while (remaining > 0) {
        const dt = Math.min(1 / 120, remaining);
        const ax = -stiffness * x - damping * vx;
        const ay = -stiffness * y - damping * vy;
        vx += ax * dt;
        vy += ay * dt;
        x += vx * dt;
        y += vy * dt;
        remaining -= dt;
      }
      const total = Math.max(1, Math.hypot(fromX, fromY));
      const progress = Math.min(1, Math.max(0, 1 - Math.hypot(x, y) / total));
      element.style.setProperty("translate", `${x.toFixed(3)}px ${y.toFixed(3)}px`);
      element.style.opacity = String(fromOpacity + (toOpacity - fromOpacity) * progress);
      if (Math.abs(x) < 0.08 && Math.abs(y) < 0.08 && Math.hypot(vx, vy) < 0.08) {
        element.style.setProperty("translate", "0px 0px");
        element.style.opacity = String(toOpacity);
        if (toOpacity >= 0.999) {
          restore();
        } else {
          element.style.setProperty("translate", previous.translate);
          element.style.willChange = previous.willChange;
        }
        running.delete(element);
        resolve();
        return;
      }
      const raf = requestAnimationFrame(frame);
      running.set(element, { raf, restore });
    };
    const raf = requestAnimationFrame(frame);
    running.set(element, { raf, restore });
  });
}

export interface SpringRevealOptions extends Omit<SpringOptions, "delay"> {
  /** The wave origin: elements nearest it start first. */
  origin?: "top-right" | "top-left" | "bottom";
  /** Spread of the wave over the viewport, in milliseconds. */
  stagger?: number;
  delayFor?: (element: HTMLElement, index: number) => number;
  distance?: number;
}

export function springReveal(elements: Iterable<HTMLElement>, options: SpringRevealOptions = {}): Promise<void> {
  const list = [...elements].filter((element) => element.isConnected && element.getClientRects().length > 0);
  const origin = options.origin ?? "bottom";
  const stagger = options.stagger ?? 180;
  const distance = options.distance ?? 36;
  const viewport = Math.max(1, innerWidth + innerHeight);
  const jobs = list.map((element, index) => {
    const rect = element.getBoundingClientRect();
    let wave = index / Math.max(1, list.length);
    if (origin === "top-right") wave = ((innerWidth - rect.right) + rect.top) / viewport;
    else if (origin === "top-left") wave = (rect.left + rect.top) / viewport;
    else wave = (innerHeight - rect.top) / Math.max(1, innerHeight);
    wave = Math.max(0, Math.min(1.3, wave));
    const delay = options.delayFor?.(element, index) ?? wave * stagger;
    const fromX = origin === "top-right" ? 18 + Math.max(0, 1 - rect.left / Math.max(1, innerWidth)) * 18 : 0;
    const fromY = origin === "bottom" ? distance : -distance;
    return springElement(element, {
      ...options,
      fromX,
      fromY,
      delay,
      fromOpacity: options.fromOpacity ?? 0,
    });
  });
  return Promise.all(jobs).then(() => undefined);
}
