import { damp, type Spring } from "../motion";
import { DEFAULT_VIEW, type ViewAngles } from "./disk";

/**
 * How the player looks at the black hole. Three numbers describe the picture of an axisymmetric system — how far above the plane
 * of the disk the viewer stands (`elevation`), how far the plane is turned on the picture (`roll`: the same as walking round the
 * hole's axis) and the size (`zoom`) — so dragging changes the first two and the wheel the third. They are springs: what the hand
 * sets is a goal, the picture follows it, a flick keeps going and slows down, and with nothing touching the view it breathes a
 * little by itself and leans a little towards the pointer. Pure numbers; `core/test/view.test.ts` has the tests.
 */

export const VIEW = {
  elevation: { min: 0.05, max: 1.3 },
  roll: { min: -1.15, max: 1.15 },
  zoom: { min: 0.55, max: 2.6 },
  /** Radians of turn for a drag of the whole height of the picture. */
  orbit: { roll: 2.3, elevation: 1.7 },
  /** How much the zoom changes for one notch of the wheel (a notch is 100 units of deltaY), as a factor. */
  notch: 1.12,
  /** The lean towards the pointer (radians at the edge of the picture) and the idle breathing (radians), with its period (s). */
  lean: { roll: 0.05, elevation: 0.04 },
  breath: { roll: 0.03, elevation: 0.026, period: 21 },
  /** Seconds the view must be left alone before it begins to breathe (and the time it takes to settle in). */
  rest: 4,
  /** How quickly the picture follows its goal (1/s) while held and when let go; how quickly a flick dies away (1/s). */
  follow: { held: 18, free: 5.2 },
  friction: 3.6,
} as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export class DiskView {
  readonly elevation: Spring = { value: DEFAULT_VIEW.elevation, velocity: 0 };
  readonly roll: Spring = { value: DEFAULT_VIEW.roll, velocity: 0 };
  readonly zoom: Spring = { value: DEFAULT_VIEW.zoom, velocity: 0 };
  /** What the hand has set (the picture adds the lean and the breathing on top). */
  readonly goal: ViewAngles = { ...DEFAULT_VIEW };
  /** The flick that is still going (radians/s). */
  private flick = { roll: 0, elevation: 0 };
  private held = false;
  private still = 0;
  private time = 0;
  /** The view as drawn this frame (the springs plus the lean and the breathing). */
  readonly now: ViewAngles = { ...DEFAULT_VIEW };

  /** A hand has taken hold of the picture. */
  grab() {
    this.held = true;
    this.still = 0;
    this.flick.roll = this.flick.elevation = 0;
  }

  /** The hand moved by (`dx`, `dy`) as shares of the picture's height (right and down are positive). */
  drag(dx: number, dy: number) {
    this.still = 0;
    this.goal.roll = clamp(this.goal.roll + dx * VIEW.orbit.roll, VIEW.roll.min, VIEW.roll.max);
    this.goal.elevation = clamp(this.goal.elevation + dy * VIEW.orbit.elevation, VIEW.elevation.min, VIEW.elevation.max);
  }

  /** The hand let go while moving at (`vx`, `vy`) picture heights per second. */
  release(vx = 0, vy = 0) {
    this.held = false;
    this.still = 0;
    this.flick.roll = clamp(vx * VIEW.orbit.roll, -6, 6);
    this.flick.elevation = clamp(vy * VIEW.orbit.elevation, -6, 6);
  }

  /** The wheel (or a pinch) asks for a change of size: `notches` > 0 comes closer. */
  zoomBy(notches: number) {
    this.still = 0;
    this.goal.zoom = clamp(this.goal.zoom * Math.pow(VIEW.notch, notches), VIEW.zoom.min, VIEW.zoom.max);
  }

  /** A pinch: the size is multiplied by `factor` (> 1 comes closer). */
  scaleBy(factor: number) {
    this.still = 0;
    this.goal.zoom = clamp(this.goal.zoom * factor, VIEW.zoom.min, VIEW.zoom.max);
  }

  /** Back to the composed picture. */
  reset() {
    this.held = false;
    this.still = 0;
    this.flick.roll = this.flick.elevation = 0;
    Object.assign(this.goal, DEFAULT_VIEW);
  }

  /** True while the player has the view somewhere other than the composed picture. */
  get changed(): boolean {
    return Math.abs(this.goal.roll - DEFAULT_VIEW.roll) > 0.01 || Math.abs(this.goal.elevation - DEFAULT_VIEW.elevation) > 0.01 || Math.abs(this.goal.zoom - 1) > 0.01;
  }

  /** True while the picture is still moving by itself (a flick, the springs settling, the breathing). */
  get moving(): boolean {
    return (
      this.held ||
      Math.abs(this.flick.roll) > 0.01 ||
      Math.abs(this.flick.elevation) > 0.01 ||
      [this.elevation, this.roll, this.zoom].some((spring) => Math.abs(spring.velocity) > 0.0005) ||
      Math.abs(this.elevation.value - this.now.elevation) > 0.0004 ||
      Math.abs(this.roll.value - this.now.roll) > 0.0004 ||
      Math.abs(this.zoom.value - this.goal.zoom) > 0.0004
    );
  }

  /**
   * Advance by `dt` seconds. `pointer` is where the pointer is on the picture (−1 … 1, y up) or null; `calm` (reduced motion) leaves
   * out the lean and the breathing, and `instant` makes the picture land on its goal at once.
   */
  update(dt: number, pointer: { x: number; y: number } | null = null, calm = false, instant = false): ViewAngles {
    dt = clamp(dt, 0, 0.05);
    this.time += dt;
    if (!this.held) {
      this.still += dt;
      // A flick carries the goal on, and slows down; against a limit it stops.
      const decay = Math.exp(-VIEW.friction * dt);
      const roll = this.goal.roll + this.flick.roll * dt;
      const elevation = this.goal.elevation + this.flick.elevation * dt;
      this.goal.roll = clamp(roll, VIEW.roll.min, VIEW.roll.max);
      this.goal.elevation = clamp(elevation, VIEW.elevation.min, VIEW.elevation.max);
      if (this.goal.roll !== roll) this.flick.roll = 0;
      if (this.goal.elevation !== elevation) this.flick.elevation = 0;
      this.flick.roll *= decay;
      this.flick.elevation *= decay;
      if (Math.abs(this.flick.roll) < 0.01) this.flick.roll = 0;
      if (Math.abs(this.flick.elevation) < 0.01) this.flick.elevation = 0;
    }
    // The lean and the breath sit on top of the goal; they fade in once the view has been left alone.
    let leanRoll = 0;
    let leanElevation = 0;
    if (!calm) {
      const rest = clamp((this.still - VIEW.rest) / VIEW.rest, 0, 1);
      const phase = (this.time / VIEW.breath.period) * Math.PI * 2;
      leanRoll = Math.sin(phase) * VIEW.breath.roll * rest;
      leanElevation = Math.sin(phase * 0.73 + 1.3) * VIEW.breath.elevation * rest;
      if (pointer && !this.held) {
        leanRoll += pointer.x * VIEW.lean.roll;
        leanElevation -= pointer.y * VIEW.lean.elevation;
      }
    }
    const rate = instant ? 60 : this.held ? VIEW.follow.held : VIEW.follow.free;
    damp(this.roll, this.goal.roll + leanRoll, rate, dt);
    damp(this.elevation, this.goal.elevation + leanElevation, rate, dt);
    damp(this.zoom, this.goal.zoom, instant ? 60 : 9, dt);
    // The springs may overshoot a limit a little; the picture never does.
    this.now.roll = clamp(this.roll.value, VIEW.roll.min - 0.1, VIEW.roll.max + 0.1);
    this.now.elevation = clamp(this.elevation.value, VIEW.elevation.min * 0.8, VIEW.elevation.max + 0.08);
    this.now.zoom = clamp(this.zoom.value, VIEW.zoom.min * 0.9, VIEW.zoom.max * 1.05);
    return this.now;
  }
}
