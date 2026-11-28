/**
 * Vitrine's shared, physically integrated spring motion.
 *
 * Apple's fluid-interface guidance asks for continuous, interruptible motion
 * described by damping and response instead of a fixed duration. This file
 * therefore integrates a damped harmonic oscillator at a fixed 120 Hz inside
 * requestAnimationFrame, then writes the result to independent CSS
 * `translate` / `scale` / `rotate` properties. It never uses CSS keyframes or
 * timed transitions for a UI transition.
 *
 * The pointer's recent speed is treated as the force of the gesture: a quick
 * flick starts the spring with more momentum and very slightly less damping,
 * while a quiet tap starts close to critically damped. The damping ratio stays
 * below 1 so every landing keeps a small, controlled overshoot.
 */

export type SpringTarget = HTMLElement | SVGElement;

export interface SpringOptions {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  fromScale?: number;
  toScale?: number;
  fromOpacity?: number;
  toOpacity?: number;
  fromRotate?: number;
  toRotate?: number;
  fromBlur?: number;
  toBlur?: number;
  /** A `circle()` reveal radius in percent. Set both to animate a circular mask. */
  fromClip?: number;
  toClip?: number;
  clipOrigin?: string;
  transformOrigin?: string;
  /** Perceptual response in seconds. Converted to stiffness; no animation duration is used. */
  response?: number;
  stiffness?: number;
  dampingRatio?: number;
  velocityX?: number;
  velocityY?: number;
  velocityScale?: number;
  force?: number;
  delay?: number;
  /** Keep the last inline values after settling instead of restoring the element's base styles. */
  retainFinal?: boolean;
  onFrame?: (state: Readonly<SpringFrameState>) => void;
}

export interface SpringFrameState {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotate: number;
  blur: number;
  /** Normalised distance travelled, 0 at the start and 1 at rest. */
  progress: number;
  vx: number;
  vy: number;
}

interface StyleSnapshot {
  translate: string;
  scale: string;
  rotate: string;
  opacity: string;
  filter: string;
  clipPath: string;
  transformOrigin: string;
  willChange: string;
}

interface ActiveSpring {
  raf: number;
  restore: (retain?: boolean) => void;
  state: SpringFrameState;
  base: StyleSnapshot;
}

const running = new WeakMap<SpringTarget, ActiveSpring>();
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

/** A click/drag imparts more initial velocity to the next spring. */
export function currentSpringForce(): number {
  return pointerForce;
}

function snapshot(element: SpringTarget): StyleSnapshot {
  return {
    translate: element.style.getPropertyValue("translate"),
    scale: element.style.getPropertyValue("scale"),
    rotate: element.style.getPropertyValue("rotate"),
    opacity: element.style.opacity,
    filter: element.style.filter,
    clipPath: element.style.clipPath,
    transformOrigin: element.style.transformOrigin,
    willChange: element.style.willChange,
  };
}

function restoreStyle(element: SpringTarget, base: StyleSnapshot) {
  element.style.setProperty("translate", base.translate);
  element.style.setProperty("scale", base.scale);
  element.style.setProperty("rotate", base.rotate);
  element.style.opacity = base.opacity;
  element.style.filter = base.filter;
  element.style.clipPath = base.clipPath;
  element.style.transformOrigin = base.transformOrigin;
  element.style.willChange = base.willChange;
}

function cancelSpring(element: SpringTarget): ActiveSpring | undefined {
  const active = running.get(element);
  if (!active) return undefined;
  cancelAnimationFrame(active.raf);
  running.delete(element);
  return active;
}

function reducedMotion(element: SpringTarget) {
  return matchMedia("(prefers-reduced-motion: reduce)").matches || Boolean(element.closest(".reduce-motion"));
}

function stiffnessOf(options: Pick<SpringOptions, "response" | "stiffness">) {
  if (options.response !== undefined && options.response > 0) {
    return Math.pow((Math.PI * 2) / options.response, 2);
  }
  return Math.max(24, options.stiffness ?? 220);
}

function ratioOf(requested: number, force: number) {
  // Momentum lowers the ratio a little; taps stay near 0.94. Still always < 1.
  const momentum = Math.max(0, Math.min(0.9, force - 1));
  return Math.max(0.56, Math.min(0.98, requested - momentum * 0.12));
}

function clipPath(radius: number | undefined, origin: string) {
  return radius === undefined ? "" : `circle(${Math.max(0, radius).toFixed(3)}% at ${origin})`;
}

/** Animate one element with a damped spring and resolve once it has settled. */
export function springElement(element: SpringTarget, options: SpringOptions = {}): Promise<void> {
  const previousActive = cancelSpring(element);
  const base = previousActive?.base ?? snapshot(element);
  const prior = previousActive?.state;
  const reduced = reducedMotion(element);
  const toX = options.toX ?? 0;
  const toY = options.toY ?? 0;
  const toScale = options.toScale ?? 1;
  const toOpacity = options.toOpacity ?? 1;
  const toRotate = options.toRotate ?? 0;
  const toBlur = options.toBlur ?? 0;
  const hasClip = options.fromClip !== undefined && options.toClip !== undefined;
  const toClip = hasClip ? options.toClip : undefined;
  const clipOrigin = options.clipOrigin ??
    (options.transformOrigin?.includes("right") || options.transformOrigin?.includes("100%")
      ? "100% 0%"
      : options.transformOrigin?.includes("bottom") || options.transformOrigin?.includes("100%")
        ? "50% 100%"
        : "50% 50%");
  const fromX = options.fromX ?? prior?.x ?? 0;
  const fromY = options.fromY ?? prior?.y ?? 0;
  const fromScale = options.fromScale ?? prior?.scale ?? 1;
  const fromOpacity = options.fromOpacity ?? prior?.opacity ?? 1;
  const fromRotate = options.fromRotate ?? prior?.rotate ?? 0;
  const fromBlur = options.fromBlur ?? prior?.blur ?? 0;
  const fromClip = options.fromClip;
  const delay = Math.max(0, options.delay ?? 0);
  const force = Math.max(0.2, Math.min(2.5, options.force ?? currentSpringForce()));
  const requestedRatio = options.dampingRatio ?? 0.84;
  const dampingRatio = ratioOf(requestedRatio, force);
  const stiffness = stiffnessOf(options);
  const damping = 2 * dampingRatio * Math.sqrt(stiffness);
  const momentum = Math.max(0, force - 1) * 1.45;
  let x = fromX;
  let y = fromY;
  let scale = Math.max(0.01, fromScale);
  let opacity = Math.max(0, Math.min(1, fromOpacity));
  let rotate = fromRotate;
  let blur = Math.max(0, fromBlur);
  let clip = fromClip;
  let vx = options.velocityX ?? (toX - fromX) * momentum;
  let vy = options.velocityY ?? (toY - fromY) * momentum;
  let vScale = (toScale - fromScale) * momentum;
  let vOpacity = (toOpacity - fromOpacity) * momentum * 0.4;
  let vRotate = (toRotate - fromRotate) * momentum * 0.45;
  let vBlur = (toBlur - fromBlur) * momentum * 0.5;
  let vClip = fromClip === undefined || toClip === undefined ? 0 : (toClip - fromClip) * momentum;
  let last = 0;
  let started = false;
  let stillFrames = 0;
  let lastVisualX = fromX;
  let lastVisualY = fromY;
  let lastVisualScale = fromScale;
  let lastVisualOpacity = fromOpacity;
  const startedAt = performance.now();

  if (options.transformOrigin) element.style.transformOrigin = options.transformOrigin;
  element.style.willChange = "translate, scale, rotate, opacity, filter, clip-path";

  const startState: SpringFrameState = { x, y, scale, opacity, rotate, blur, progress: 0, vx, vy };
  const write = (progress: number) => {
    element.style.setProperty("translate", `${x.toFixed(3)}px ${y.toFixed(3)}px`);
    element.style.setProperty("scale", String(Math.max(0.01, scale).toFixed(5)));
    element.style.setProperty("rotate", `${rotate.toFixed(3)}deg`);
    element.style.opacity = String(Math.max(0, Math.min(1, opacity)));
    if (fromBlur !== 0 || toBlur !== 0) element.style.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : "";
    if (hasClip) element.style.clipPath = clipPath(clip ?? 0, clipOrigin);
    const state: SpringFrameState = { x, y, scale, opacity, rotate, blur, progress, vx, vy };
    options.onFrame?.(state);
  };

  if (reduced) {
    x = toX; y = toY; scale = toScale; opacity = toOpacity; rotate = toRotate; blur = toBlur; clip = toClip;
    write(1);
    if (options.retainFinal || toX !== 0 || toY !== 0 || toScale !== 1 || toOpacity !== 1 || toRotate !== 0 || toBlur !== 0) {
      element.style.willChange = base.willChange;
    } else {
      restoreStyle(element, base);
    }
    return Promise.resolve();
  }

  const totalTravel = Math.max(1, Math.hypot(toX - fromX, toY - fromY, (toScale - fromScale) * 120, (toOpacity - fromOpacity) * 80));
  write(0);

  return new Promise((resolve) => {
    const settle = () => {
      x = toX; y = toY; scale = toScale; opacity = toOpacity; rotate = toRotate; blur = toBlur; clip = toClip;
      write(1);
      if (options.retainFinal || toX !== 0 || toY !== 0 || toScale !== 1 || toOpacity !== 1 || toRotate !== 0 || toBlur !== 0) {
        element.style.willChange = base.willChange;
      } else {
        restoreStyle(element, base);
      }
      running.delete(element);
      resolve();
    };

    const frame = (now: number) => {
      if (!started) {
        if (now - startedAt < delay) {
          const raf = requestAnimationFrame(frame);
          running.set(element, { raf, restore: restoreStyle.bind(null, element, base), state: startState, base });
          return;
        }
        started = true;
        last = now;
      }
      const elapsed = Math.min(0.5, Math.max(0.001, (now - last) / 1000));
      last = now;
      let remaining = elapsed;
      while (remaining > 0) {
        const dt = Math.min(1 / 120, remaining);
        const ax = -stiffness * (x - toX) - damping * vx;
        const ay = -stiffness * (y - toY) - damping * vy;
        const as = -stiffness * (scale - toScale) - damping * vScale;
        const ao = -stiffness * (opacity - toOpacity) - damping * vOpacity;
        const ar = -stiffness * (rotate - toRotate) - damping * vRotate;
        const ab = -stiffness * (blur - toBlur) - damping * vBlur;
        const ac = -stiffness * ((clip ?? toClip ?? 0) - (toClip ?? clip ?? 0)) - damping * vClip;
        vx += ax * dt;
        vy += ay * dt;
        vScale += as * dt;
        vOpacity += ao * dt;
        vRotate += ar * dt;
        vBlur += ab * dt;
        vClip += ac * dt;
        x += vx * dt;
        y += vy * dt;
        scale += vScale * dt;
        rotate += vRotate * dt;
        blur += vBlur * dt;
        if (clip !== undefined && toClip !== undefined) clip += vClip * dt;
        opacity += vOpacity * dt;
        // Opacity is clamped only for painting; its spring state can still
        // settle naturally and interpolate exactly like every other channel.
        opacity = Math.max(0, Math.min(1, opacity));
        remaining -= dt;
      }
      scale = Math.max(0.01, scale);
      opacity = Math.max(0, Math.min(1, opacity));
      blur = Math.max(0, blur);
      const remainingDistance = Math.hypot(x - toX, y - toY, (scale - toScale) * 120, (opacity - toOpacity) * 80, (rotate - toRotate) * 0.7);
      const progress = Math.max(0, Math.min(1, 1 - remainingDistance / totalTravel));
      write(progress);
      const visualChange =
        Math.abs(x - lastVisualX) +
        Math.abs(y - lastVisualY) +
        Math.abs(scale - lastVisualScale) * 120 +
        Math.abs(opacity - lastVisualOpacity) * 80;
      if (visualChange < 0.012) stillFrames++;
      else stillFrames = 0;
      lastVisualX = x;
      lastVisualY = y;
      lastVisualScale = scale;
      lastVisualOpacity = opacity;
      const closeEnough =
        Math.abs(x - toX) < 0.08 &&
        Math.abs(y - toY) < 0.08 &&
        Math.abs(scale - toScale) < 0.0008 &&
        Math.abs(opacity - toOpacity) < 0.004 &&
        Math.abs(rotate - toRotate) < 0.02 &&
        Math.abs(blur - toBlur) < 0.04 &&
        (clip === undefined || toClip === undefined || Math.abs(clip - toClip) < 0.06);
      const atRest = closeEnough && stillFrames >= 2;
      if (atRest) {
        settle();
        return;
      }
      const state: SpringFrameState = { x, y, scale, opacity, rotate, blur, progress, vx, vy };
      const raf = requestAnimationFrame(frame);
      running.set(element, { raf, restore: restoreStyle.bind(null, element, base), state, base });
    };
    const raf = requestAnimationFrame(frame);
    running.set(element, { raf, restore: restoreStyle.bind(null, element, base), state: startState, base });
  });
}

export interface SpringRevealOptions extends Omit<SpringOptions, "delay" | "fromX" | "fromY"> {
  /** The wave origin: elements nearest it start first. */
  origin?: "top-right" | "top-left" | "bottom";
  /** Spread of the wave over the viewport, in milliseconds. */
  stagger?: number;
  delayFor?: (element: HTMLElement, index: number) => number;
  /** Vertical travel from the origin. */
  distance?: number;
}

/** Reveal a set of elements as one radial wave. Geometry is read once, then each element owns its spring. */
export function springReveal(elements: Iterable<HTMLElement>, options: SpringRevealOptions = {}): Promise<void> {
  const list = [...elements].filter((element) => element.isConnected && element.getClientRects().length > 0);
  const origin = options.origin ?? "bottom";
  const stagger = options.stagger ?? 220;
  const distance = options.distance ?? 40;
  const originX = origin === "top-right" ? innerWidth : origin === "top-left" ? 0 : innerWidth / 2;
  const originY = origin === "bottom" ? innerHeight : 0;
  const diagonal = Math.max(1, Math.hypot(innerWidth, innerHeight));
  const transformOrigin = origin === "top-right" ? "100% 0%" : origin === "top-left" ? "0% 0%" : "50% 100%";
  const clipOrigin = origin === "top-right" ? "100% 0%" : origin === "top-left" ? "0% 0%" : "50% 100%";
  const jobs = list.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const wave = Math.max(0, Math.min(1.2, Math.hypot(cx - originX, cy - originY) / diagonal));
    const delay = options.delayFor?.(element, index) ?? wave * stagger;
    const fromX = origin === "bottom" ? 0 : (origin === "top-right" ? 1 : -1) * (18 + wave * 72 + rect.width * 0.08);
    const fromY = origin === "bottom" ? distance : -(distance * (1 + wave * 0.62));
    return springElement(element, {
      ...options,
      fromX,
      fromY,
      fromOpacity: options.fromOpacity ?? 0,
      fromScale: options.fromScale ?? 0.64,
      fromBlur: options.fromBlur ?? 4,
      transformOrigin: options.transformOrigin ?? transformOrigin,
      clipOrigin: options.clipOrigin ?? clipOrigin,
      delay,
    });
  });
  return Promise.all(jobs).then(() => undefined);
}

export interface SpringNumberOptions {
  from: number;
  to: number;
  response?: number;
  stiffness?: number;
  dampingRatio?: number;
  velocity?: number;
  force?: number;
  delay?: number;
  onUpdate: (value: number) => void;
}

/** A one-dimensional spring for numeric UI properties such as a nav width or a knob position. */
export function springNumber(options: SpringNumberOptions): Promise<void> {
  const force = Math.max(0.2, Math.min(2.5, options.force ?? currentSpringForce()));
  const stiffness = stiffnessOf(options);
  const dampingRatio = ratioOf(options.dampingRatio ?? 0.87, force);
  const damping = 2 * dampingRatio * Math.sqrt(stiffness);
  const target = options.to;
  const momentum = Math.max(0, force - 1) * 1.2;
  let value = options.from;
  let velocity = options.velocity ?? (target - value) * momentum;
  let last = 0;
  let started = false;
  const startedAt = performance.now();
  const delay = Math.max(0, options.delay ?? 0);
  options.onUpdate(value);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || Boolean(document.querySelector("#stage.reduce-motion"))) {
    options.onUpdate(target);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (!started) {
        if (now - startedAt < delay) return requestAnimationFrame(frame);
        started = true;
        last = now;
      }
      let remaining = Math.min(0.5, Math.max(0.001, (now - last) / 1000));
      last = now;
      while (remaining > 0) {
        const dt = Math.min(1 / 120, remaining);
        velocity += (-stiffness * (value - target) - damping * velocity) * dt;
        value += velocity * dt;
        remaining -= dt;
      }
      options.onUpdate(value);
      if (Math.abs(value - target) < 0.02 && Math.abs(velocity) < 0.05) {
        options.onUpdate(target);
        resolve();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
