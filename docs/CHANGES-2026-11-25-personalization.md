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
real depth. Large sheets and dialogs also run the static SVG displacement
lens from the supplied `liquid-glass` source, giving a genuine refractive
backdrop without animating the whole interface.

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
a hedgehog. The opening card now uses the same `1.22` world scale as the band
plates; perspective still makes the centre card readable, but it no longer
breaks the ring's proportions.

The PBR picker previously reached the archive shells but not `FinMesh`, the
single instanced mesh that actually draws the dense Möbius fins. `FinMesh` now
accepts the same `RingMaterialPreset` and applies its metal, roughness,
clearcoat, environment intensity and emissive response after the theme/deep
space blend. Switching a preset now visibly recolours the ring itself.

A tenth look, **流光白**, was added. Its shell/glass families use cool pearl
white, while the fin mesh keeps a silver-gray base and computes a narrow white
crest per instance from the plate's position along the band and the scene
clock. The crest follows the ring through its morphs and costs no extra draw
call; a small cool emissive prevents the gold studio key from turning it beige.
