# liquid-glass

Vitrine's static SVG backdrop lens in `src/liquid-glass-filter.ts` is adapted
from the `liquid-glass` source supplied by the Vitrine author at
`/storage/emulated/0/Vitrine/liquid-glass-main`.

- Author: Dominik Pawlikowski
- License: MIT (see `liquid-glass-LICENSE.txt`)

Only the `feTurbulence` + `feDisplacementMap` filter is reused. The React
component, demo layout, drag system and control panel are not bundled.
Vitrine retains its own DOM, animation, spring and interaction systems.
