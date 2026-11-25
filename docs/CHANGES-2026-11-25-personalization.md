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

## Wallpaper and sampled card light

Images and videos can be imported from Settings → 个性化. The desktop shell
turns a user-picked absolute path into an opaque `vitrine-media://` token URL;
the renderer never receives a `file://` URL. The protocol supports HTTP byte
ranges, which keeps video seeking and playback efficient.

When WebGL is live the wallpaper is a full-screen plane inside the WebGL pass.
This gives correct occlusion and physically plausible glass reflections while
keeping one compositor frame. The DOM wallpaper layer remains as the fallback
when WebGL is unavailable. A small frame is sampled to derive an adaptive
accent, flow colours and a deep shadow colour; the cards, liquid edges and
chrome use those variables. Pointer parallax and the shader vignette provide a
lightweight simulated depth without a per-pixel depth reconstruction pass.

Video playback pauses when the launcher is hidden, unfocused, when a game is
running, or when the player pauses it from settings.

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
shows the previous/current/next lyric lines; the current line uses its own
spring reveal. The home view tabs were moved below the island and checked at
1352, 1024 and 960 px widths for non-overlap.

## Startup warm-up and game resources

`src/app/warmup.ts` begins loading the splash font samples and the cassette GLB
as soon as the app module starts. The GLB bytes are held in an in-memory cache
and taken exactly once by `GLTFLoader.parseAsync`, then released. The splash
animation remains CSS-first and can be skipped as before.

When a game is running, the launcher temporarily lowers its WebGL quality to
the low tier (minimal on software GPUs), freezes decorative compositor
animations and pauses wallpaper video. The normal tier is restored when the
game exits. G1 heap-region sizing now follows the actual heap allocation
(8/16/32 MB) instead of always using 32 MB. Microsoft account refresh now
retrieves and persists the Xbox `xuid` and passes it into `auth_xuid`, with a
one-time repair refresh for older accounts that predate this field.
