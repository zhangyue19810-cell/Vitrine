# Vitrine 2026-11-25 — personalisation, custom downloads and game-mode resources

## Ring PBR materials

`src/ring-materials.ts` defines nine looks: black-gold studio glass, crimson
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
