# Vitrine 2026-11-25 — personalisation, custom downloads and game-mode resources

## Ring PBR materials

`src/ring-materials.ts` defines ten looks: black-gold studio glass, crimson
lacquer, violet satin metal, azure chrome glass, pearl ceramic, jade enamel,
rose copper, obsidian gold and matte carbon. Each preset sets independent
colour, metalness, roughness, clearcoat, transmission, thickness, attenuation
and environment intensities for the glass, metal, inlay and edge surface
families. `CardAppearance` applies the look to both the extracted cassette and
the instanced ring, including the fast material clone used by the minimal
quality tier. Settings → 个性化 switches it live and the choice persists in
`localStorage` under `vitrine.visuals.v1`.

## Thicker archive glass and a new edge material

The archive GLB's metallic-roughness materials are promoted to physical
materials on load so every surface can use clearcoat, transmission, sheen and
iridescence. The front cover now has a thicker PBR stack: `thickness 0.78`,
`ior 1.52`, low roughness, dispersion, a shorter attenuation distance and a
soft iridescent layer. The model's depth axis is stretched to 1.38× so the
thicker optical stack has a visible side wall. The painted face decals and the
selected-instance label are moved outward with `ARCHIVE_FACE_Z`, keeping every
project icon, instance label and music archive face in front of the cover
instead of hidden inside its new volume. The instanced row keeps a lighter
version for the download/Mod view while retaining the dense tint.

`archiveEdgeFragment` ports the useful part of Lumina UI's liquid-glass shader
to the card silhouette: a dark thick wall at grazing angles, a narrow inner
bevel and a lit champagne rim. The old translucent ivory rail is now brushed
champagne metal, while the internal optical shoulder uses darker polished
metal. The result is one extra shader branch in the existing PBR programs, not
another mesh or fullscreen pass.

The wallpaper/video experiment was removed completely, including its Electron
media protocol, settings controls, scene background plane and adaptive palette
sampling.

## Custom download

The account capsule now contains **自定义下载**. It accepts an HTTP(S) URL,
destination folder, optional filename, source policy and 1–16 segment
connections. For GitHub URLs it builds candidates for:

- GitHub direct;
- Aliyun GitHub mirror;
- Huaqing/Huawei Cloud GitHub mirror;
- ghfast, gh-proxy and ghproxy cloud accelerators.

Every candidate is measured concurrently on a small range request. HTML
landing pages, 4xx responses and stalled connections are rejected. The fastest
healthy source is used for the real download, with the other healthy sources
retained as fallbacks. The transfer runs through the same segmented downloader
as game files (Range, single-stream fallback, retries, temporary files and
atomic rename). It appears in the normal task manager and the top island.

Mirror availability varies by repository; an HTML landing page or a 404 from a
mirror is expected to be skipped when that mirror does not carry the asset.

## Quick island (ported from Lumina UI's IslandChat)

The launcher island now follows the geometry and motion of the user's earlier
`/storage/emulated/0/luminaui` mod: a pure-black capsule with a thin mirror
rim and a tiny blue sensor dot in the collapsed bar. Width, height, vertical
position and alpha are four damped springs (stiffness 240/240/200/120), so
opening, collapsing and leaving overshoot and settle like the in-game island
instead of switching CSS sizes.

Input opens it for five seconds, then it collapses to the sensor bar; ten
seconds after the last real input it leaves completely. Progress and lyric
events update content but do not reset inactivity. A finished download opens
for exactly three seconds, then collapses to the sensor bar and leaves on the
same ten-second rule. While a song plays and the user is active, the island
shows the previous/current/next lyric lines using the same sans stack, ivory
to amber grade, blurred neighbour slots and spring fill motion as the music
page's lyric layer. The home view tabs were moved below the island and checked at
1352, 1024 and 960 px widths for non-overlap.

The account capsule's reveal menu now drops down from the capsule instead of
growing left across the stage. It is absolutely anchored under the right-hand
pill, opens with an overshooting damped keyframe, and keeps the capsule itself
fixed. This removes the last overlap between the enlarged navigation capsule
and the centre-top island.

## Startup warm-up and game resources

`src/app/warmup.ts` begins loading the splash font samples and the cassette GLB
as soon as the app module starts. The GLB bytes are held in an in-memory cache
and taken exactly once by `GLTFLoader.parseAsync`, then released. The splash
animation remains CSS-first and can be skipped as before.

When a game is running, the launcher temporarily lowers its WebGL quality to
the low tier (minimal on software GPUs) and freezes decorative compositor
animations. The normal tier is restored when the
game exits. G1 heap-region sizing now follows the actual heap allocation
(8/16/32 MB) instead of always using 32 MB. Microsoft account refresh now
retrieves and persists the Xbox `xuid` and passes it into `auth_xuid`, with a
one-time repair refresh for older accounts that predate this field.

## Flowing-light cards

The generic liquid-glass-source experiment was dropped in favour of a lighter
material pass built on the card system already in the launcher. Every framed
surface now owns two light layers:

- `.liquid-edge` keeps a narrow gold/white/teal highlight travelling around
  the rim; it runs on all cards instead of only while hovered;
- `.liquid-flow` sits behind the card's content with a soft diagonal caustic
  that sweeps across the body on a delayed loop, so a grid of cards does not
  pulse in lockstep.

Buttons and capsule controls use the same two layers at lower intensity plus
a soft blue/amber/mint bloom towards their trailing edge. Hovering a capsule
also grows a circular `.liquid-drop` from the pointer: it begins as a tiny
bead, covers the pill evenly in every direction and never translates downward.
The nav bar re-scans containers when their `innerHTML` is replaced, so the
light layers survive account-menu rebuilds and dynamic card lists.

Both layers are generated by the existing delegated liquid-light controller,
so cards created later by search, settings or the music page receive them
automatically. The material retains the warm black-gold palette and the
existing pointer sheen, tilt, archive choreography, island springs and page
transitions. The body sweep animates only a transform and opacity; the rim
keeps the existing masked-gradient travel. Both stop with the other decorative
motion when a game is running, the window is hidden, or reduced motion is
requested.

## 3D frosted-glass cards

The card layer was pushed closer to the supplied form reference. A sheet is
now a floating 32px-radius card inset into the stage, not a full-window panel:
the blurred stage behind it provides the frosted backdrop, while the card's
outer drop shadow, white top/left wall and darker bottom/right wall produce
real depth. Dialogs run a lightweight radial-lens SVG filter based on the
supplied shader: an inward seventh-power displacement map plus a 1.1px sample
blur. It is pre-baked to a PNG once, so no turbulence is animated over the
live 3D scene.

Inside the card, the light is deliberately uneven: a cool blue field at the
upper right, mint near the middle, peach at the lower edge and a lavender
corner all drift independently. In light mode these layers use normal
blending (screen blending was washing them out on white); in dark mode they
screen over the smoked surface. The same layer feeds the existing travelling
rim and water-bead capsule reveal.

Form controls follow the reference's state language: neutral glass fields,
a blue focus lens, a red invalid ring with a cross and red hint, and a green
valid ring with a check. In the light theme the primary action and the on
toggle use cool blue-white glass as in the reference; the dark theme keeps
the launcher's black-gold identity. Blurred text and a darkening veil are
applied to the stage behind an open sheet so the frosted card never lets the
underlying HUD cut through sharply.

The SVG filter is adapted from the MIT-licensed source; attribution and the
licence are in `docs/third-party/`.

## Möbius ring size, material switching and flowing white

The extracted archive at the ring opening used its own `HOLE.scale` of `2.1`
while the band plates used `RING_CARD.scale` of `1.22`. One front-facing slab
therefore towered over the evenly sized ring and made the silhouette read like
a hedgehog. The archive shells are now scaled to `0.95`, which matches the
physical 4.4 × 3.7 size of the Möbius fins; the opening card and the band cards
use the same `0.95` scale, so a selected archive no longer looks like a
different species of object. The fin lean and wave were reduced as well, so
the band reads as a ribbon instead of a ring of spikes.

The PBR picker previously reached the archive shells but not `FinMesh`, the
single instanced mesh that actually draws the dense Möbius fins. `FinMesh` now
accepts the same `RingMaterialPreset` and applies its metal, roughness,
clearcoat, environment intensity and emissive response after the theme/deep
space blend. Switching a preset now visibly recolours the ring itself.

A tenth look, **流光白**, was added. Its shell/glass families use a low-metal
cool pearl response (including a cool printed-face palette), while the fin
mesh keeps a silver-blue base and computes a narrow white crest per instance
from the plate's position along the band and the scene clock. The crest
follows the ring through its morphs and costs no extra draw call. Because the
studio key is champagne, this preset explicitly lowers metalness and
environment reflection and adds a restrained cool emissive; otherwise every
gray surface reflects the warm room and reads brown.

## Music search and renderer-stall fixes

The public NetEase route `cloudsearch/get/web` began answering `50000005`
for guest searches. The client now uses the current web-player route
`cloudsearch/pc` first, keeps the old route as a fallback, and the mock server
exercises both. A live search for `周杰伦` now returns 30 songs instead of an
error toast.

Quality selection is now a four-button segmented control instead of a native
`<select>`. This removes the native popup path that could fall through to an
unrelated file/folder dialog in the transparent Windows window and makes the
change immediate and inspectable.

Several renderer hotspots were reduced after the music→home regression:

- the live SVG displacement filter is limited to small dialogs; the home
  chrome and the large settings sheet use the cheaper frosted blur;
- animated pseudo-layers no longer carry a per-frame `filter: blur()`;
- nested settings rows no longer repeat a backdrop filter over the already
  blurred sheet;
- the flowing-white instance colours are uploaded at 12 Hz rather than every
  rendered frame;
- `instanceColor` versioning is still tracked so the flow remains animated,
  but render-state reuse is no longer defeated at full frame rate.

## Long-session memory and compositor load

Two gradual-load paths were closed after the "fine at first, slower after a
while" report:

- `MusicView.covers` was an unbounded decoded-image map. It is now a 120-entry
  LRU, trimmed to 60 covers when leaving the music page; repeated searches no
  longer keep every cover image alive forever.
- the quality governor now publishes its effective tier on
  `document.documentElement` as `data-render-tier`. When it reaches `low` the
  decorative flowing-light animations stop and live frost is reduced to a
  15px blur; at `minimal` backdrop sampling and the decoration stop entirely,
  while the layered colour/rim glass remains. The scheduler's `idle` and
  `idle-deep` states also pause purely decorative flow, resuming on the next
  pointer movement. This prevents a long-running launcher from accumulating
  compositor/GPU work after the first interaction has passed.

## Native select removal and the glass transport

Electron's native `<select>` popup was the remaining file-manager path: clicking
动效 or 帧率 could flash the OS menu and hand focus to Explorer. Every existing
`select.select` (including controls rendered later) is now intercepted by a
delegated in-app menu. The original select still owns the value and dispatches
`change`, so existing settings handlers are unchanged, but Chromium never opens
a native popup. The menu uses the same glass `role="menu"` panel as the rest of
the launcher and marks the current option with a check.

The music transport capsule now has its own transparent pearl-glass body
instead of inheriting the opaque card fill:

- 30px live frost with higher saturation and brightness;
- blue and warm refraction fields across the pill;
- thick inset top/bottom walls and chromatic left/right edges;
- an always-running soft rim plus the existing pointer water-fill;
- a top sheen that keeps the controls readable over the black hole.

The low/minimal load-shedding rules still override the frost when the quality
governor has stepped down.

## Personal UUID removed from defaults

An imported build had baked a player's UUID into the `DEFAULT_OWNER_UUID`
constant, so Settings → 账号 displayed it as if it were a launcher default.
It is a player identifier (not a password or token), but it should never ship
inside the launcher or appear in a fresh profile.

- `DEFAULT_OWNER_UUID` is empty again, so a fresh profile ships with no
  personal UUID.
- Existing profiles keep the UUID already stored on disk — it may be the
  identity of a real offline account. Settings version 4 persists the migration
  without deleting account data.
- The UUID row is removed from the main Settings page. The account list no
  longer prints the profile UUID, and the offline-account chooser says
  “已配置，已隐藏” instead of showing the value. The hidden value is still
  available to the account manager when adding an offline account.
- With no owner UUID, adding an offline account uses the standard
  `OfflinePlayer:<name>` UUID derivation.

This also keeps the field useful for players who intentionally want several
launchers to share one offline save identity.

## Raised glass buttons

The supplied close-up reference showed a much thicker glass cross-section than
the previous flat `.btn` treatment. Buttons now have:

- a full pill silhouette (circular icon buttons stay circular);
- a separate bright outer lip rendered with `::before`, so it stays crisp
  outside the face without adding DOM nodes;
- a milky upper bevel, a dark lower wall and a hard one-pixel underside;
- a soft contact shadow and a wider ambient shadow;
- a perspective lift on hover and a compressed, inset press state;
- the same treatment on the music transport’s small control keys, with a
  brighter ring on the main play button.

The pass uses box-shadow and transform only, keeping the long-session load
shedding intact.

## Clear-centre radial lens

The previous glass was uniform frost plus painted highlights, which reads as
plastic because every part of the surface is equally blurred. The final glass
now behaves like a lens:

- `liquid-glass-filter.ts` builds a radial displacement map and a separate
  alpha rim mask. Its SVG graph blurs the backdrop, bends it toward the
  centre near the rim, masks that result to the rim, and composites it back
  over the untouched `SourceGraphic`. The centre therefore stays sharp while
  the perimeter is displaced and blurred.
- A `.liquid-lens` child adds one masked 12px blur band from about 31% radius
  outward. It is static and switches off at low/minimal tiers.
- Card fills were lowered from milky opaque values to translucent tints, so
  the backdrop can actually be seen through the middle.
- Buttons are full glass pills/circles with a separate outer bezel lip, bright
  upper bevel and dark lower wall. This follows the supplied close-up
  reference rather than relying on a flat border.

## Physical light/shadow model for the lens

The material now follows the described optical stack instead of a painted
plastic look:

- an implied light above the card gives a bright upper lip and a fading top
  reflection; the bottom wall is dark;
- the radial lens mask progressively increases blur from the clear centre to
  the rim, while the SVG displacement bends only the edge sample;
- a neutral cast shadow (large ambient + close contact) sits under each major
  surface;
- the rim uses two-tone layering: white on the upper/left wall, black on the
  lower/right wall, with a hard black underside and a separate outer glass lip
  on buttons;
- no ray tracing is used. The effect is a cached 2D displacement map, masked
  Gaussian blur and neutral CSS shadows.

To keep the running cost bounded, only the primary panels and buttons receive
the live SVG lens; individual settings rows use the cheaper frosted glass and
the static two-tone rim.
