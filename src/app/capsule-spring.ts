/** Pure damped-spring integration used by the tab capsule. */
export interface SpringStep {
  value: number;
  velocity: number;
}

export function capsuleSpringStep(value: number, velocity: number, target: number, stiffness: number, damping: number, dt = 1): SpringStep {
  const frame = Math.max(0.5, Math.min(2, dt));
  const nextVelocity = (velocity + (target - value) * stiffness * frame) * Math.pow(damping, frame);
  return { value: value + nextVelocity * frame, velocity: nextVelocity };
}
