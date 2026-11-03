# Browse — Möbius archive ring

## Intent

Replace the flat Modrinth / CurseForge result grid with one spatial artifact: a single Möbius archive
ring. No second result page, no download sheet and no separate list view are opened for content or
for task progress.

## Surface construction

The ribbon is a custom indexed Three.js strip:

```text
x = (R + v cos(u/2)) cos(u)
y = v sin(u/2)
z = (R + v cos(u/2)) sin(u)
-R/2 < v < R/2, 0 <= u <= 2pi
```

It is visualised as a translucent, double-sided teal-to-gold ribbon with one continuous boundary
stroke and regularly spaced cross-ribs. Archive cards are distributed evenly along the centerline.
Each card receives its local basis from the ribbon derivatives, so a full circuit reverses the local
normal. The labels are therefore two-sided decorative panels; the mathematical band itself stays a
zero-thickness surface.

The construction follows the 3dviz-pro-max record `recipe.mobius-orientation-trace`:
the parameter seam is not deliberately split, the centerline is a closed loop, and the boundary
stroke is treated as one continuous curve rather than two unrelated sides.

## Interaction and state

- Search / source / loader / version filters keep the existing core RPC contract.
- Results occupy the ring; `PAGE_SIZE=20` maps to one complete circuit.
- Hover raycasts the card bodies, lifts the archive and shows a floating information tooltip.
- Clicking a card selects it and eases the orbit camera to its station.
- Clicking the selected card opens a second ring of version archives in the same field.
- `Enter` starts the selected project/version. `V` opens versions. `PageUp` / `PageDown` change the
  result page. Arrow keys wrap around the ring.
- Dragging orbits the camera around the ring and raises/lowers the view.
- Download tasks are bound by task id and painted onto the owning archive label with stage, speed and
  percentage. No download modal is opened from this flow.
- Reduced-motion mode removes entrance, wave, dust drift and orbit smoothing.

## Constraints kept from the existing launcher

- Project artwork is drawn into the card label canvas; the surface itself is not a browser DOM panel.
- Project and version text is painted into canvas with the same MiSans stack as the launcher.
- A card is never selected by a raw pixel position alone: the renderer raycast and the persisted
  project/version index are kept together through replacement and page changes.
- The sheet remains a modal and keeps focus / Escape behaviour, so the rest of the launcher cannot be
  operated behind it.

## Standalone browser preview

The field is extracted without the launcher transport in `demo/mobius/` and uses local demo data.
It can be rebuilt with:

```sh
npm run check:mobius-preview
npm run build:mobius-preview
python3 -m http.server 4173 --bind 0.0.0.0 --directory .stage/mobius-preview
```

The preview intentionally keeps only the Three.js content field: Möbius ribbon, archive faces, artwork,
hover tooltip, orbit camera, selection and an on-surface simulated download progress.

## Verification

Executed:

- `tsc -p tsconfig.json --noEmit` — pass.
- `tsc -p core/tsconfig.json --noEmit` — pass.
- `tsc -p electron/tsconfig.json --noEmit` — pass.
- `vite build` — pass; `browse` chunk emitted successfully.
- `node scripts/check-browse-mobius.mjs` — pass: seam identification, two-turn boundary closure,
  closed centerline, reversed normal after one circuit and orthonormal card frames.
- `npm test` — 216/217 pass. The remaining `DownloadEngine` range-concurrency timing assertion is
  environment-sensitive in this Android/proot container and is unrelated to the browse scene.
- The extracted production `app.asar` was searched: the personal owner/tenant UUID is absent. The
  source default is now empty, and tests use a synthetic UUID.

Not executed in this environment:

- Rendered browser inspection. The cached Playwright Chromium/Firefox builds crash before page
  creation in the device container (GPU/network child processes terminate), and the Android screen has
  no authorised accessibility/device channel at the time of the build. No visual result is claimed.
- Real Windows launch. The Windows runtime still needs a normal Windows 10/11 x64 smoke test.

## Known limits

- Two-sided labels are a presentation choice for the Möbius ring, not a topological statement.
- The surface is decorative; card lifting and camera focus are interaction transforms and are not
  physical contact simulation.
- The ribbon's boundary stroke is a curve overlay. It does not add a manufactured rim to the
  mathematical surface.
