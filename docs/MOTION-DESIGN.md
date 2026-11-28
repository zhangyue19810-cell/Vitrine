# Vitrine motion design

Vitrine's interface motion follows the same principles as Apple's Human
Interface Guidelines and the *Designing Fluid Interfaces* session:

- **Purposeful, brief feedback.** Motion explains a change of state; it does
  not delay the next action.
- **Realistic continuity.** Elements follow the momentum of the interaction
  and remain interruptible while a spring is in flight.
- **Springs, not animation durations.** Following Apple's fluid-interface
  model, a transition is described by damping ratio and response/frequency,
  not by a CSS keyframe duration. The final timing is whatever the physical
  system settles to.
- **Bounce only where it communicates momentum.** Damping ratios stay below 1
  for the requested liquid feel. A faster pointer gesture adds initial
  velocity and slightly reduces damping; a quiet programmatic transition stays
  close to critically damped.
- **Reduced motion is a first-class path.** `prefers-reduced-motion` and the
  in-app “精简动效” option settle every spring immediately and remove the
  large-scale travel.

## Implementation map

- `src/app/spring-ui.ts` integrates the damped oscillator at 120 Hz inside
  `requestAnimationFrame`. It writes independent CSS `translate`, `scale`,
  `rotate`, `opacity`, `filter` and `clip-path` channels, so page-level motion
  composes with hover/press feedback.
- `src/app/spring-motion.ts` supplies delegated hover, focus, press and toggle
  springs for every button/card-like control.
- Startup, page changes, settings, sheets/dialogs, menus, toasts, download
  progress, launch screens, dynamic-island lyrics and archive assembly all use
  the same physical model.
- `src/styles/apple-motion.css` is the final stylesheet guard. It restricts
  remaining CSS transitions to colour/state cross-fades and removes the legacy
  timeline entries, square pseudo-element walls and old corner shadows.
- The archive stage uses a spring for its assembly and a delayed spring drop
  per archive, while the whole stage grows from a circle in the top-right.

Indeterminate progress indicators (busy spinner, loading shimmer) remain
continuous loops because they communicate ongoing work rather than a
transition between two interface states.

## References

- Apple Human Interface Guidelines — Motion:
  <https://developer.apple.com/design/human-interface-guidelines/motion>
- Apple Human Interface Guidelines — Accessibility:
  <https://developer.apple.com/design/human-interface-guidelines/accessibility>
- Apple WWDC 2018 — Designing Fluid Interfaces:
  <https://developer.apple.com/videos/play/wwdc2018/803/>
- Apple Developer Documentation — `CASpringAnimation`:
  <https://developer.apple.com/documentation/quartzcore/caspringanimation>
