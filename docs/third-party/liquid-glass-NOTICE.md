# liquid-glass

Vitrine's static SVG backdrop lens in `src/liquid-glass-filter.ts` is adapted
from the `liquid-glass` source supplied by the Vitrine author at
`/storage/emulated/0/Vitrine/liquid-glass-main`.

- Author: Dominik Pawlikowski
- License: MIT (see `liquid-glass-LICENSE.txt`)

The original radial displacement idea (`-dir * f * (d/r)^7` plus a light
sample blur) informed Vitrine's pre-baked SVG displacement map. The React
component, demo layout, drag system, control panel and runtime turbulence
filter are not bundled. Vitrine retains its own DOM, animation, spring and
interaction systems.
