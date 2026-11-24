import type { SceneHost } from "../scene-host";
import type { MusicPlayer, PlayerChange } from "./player";
import { MODE_LABEL, type PlayMode } from "./queue";

/**
 * The words around the black hole of the music page, in HTML laid over the picture: what is playing on the left (the cover, the
 * title, the frequency bars, the place in the song, the queue), a capsule of controls at the bottom, a hint at the right edge that
 * the archives are there, and the boxed figures that float round the hole the way they do on a star chart. Everything the service
 * sends (titles, names) is set as text, never as markup. The picture itself (the hole, the disk, the archives and the lyrics, which
 * are drawn in the scene and jump with the music) stays in the 3D scene; the hole is also the play button and its track the
 * progress bar, so the capsule is only the quiet, familiar way to do the same. While the archives are out (the pointer is on the
 * right) the left panel and the boxes give way.
 *
 * It lives inside the stage (the fixed-design surface of about 1350 × 760 virtual pixels that is scaled to the window), so every
 * length here is in those units and the 3D picture's normalised coordinates map straight onto it.
 */

const BARS = 28;
const SVG = "http://www.w3.org/2000/svg";
/** A bar is redrawn only when it moved by more than this (the bars run at the frame rate; the page need not). */
const BAR_STEP = 0.012;

const ICONS = {
  play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  prev: "M6 5h2v14H6zM19 5.5v13a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-6.5a.8.8 0 0 1 1.2.7Z",
  next: "M16 5h2v14h-2zM5 5.5v13a.8.8 0 0 0 1.2.7l8.2-6.5a.8.8 0 0 0 0-1.4L6.2 4.8A.8.8 0 0 0 5 5.5Z",
  order: "M4 7h13M4 12h13M4 17h9M20 14.5l-3 3 3 3",
  loop: "M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4",
  single: "M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4M11.2 9.8 12.4 9v6",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  volume: "M4 9v6h4l5 4V5L8 9H4ZM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
} as const;

type Icon = keyof typeof ICONS;

/** Icons that are drawn as strokes rather than filled shapes. */
const STROKED: ReadonlySet<Icon> = new Set<Icon>(["order", "loop", "single", "shuffle", "volume"]);

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name: Icon): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  if (STROKED.has(name)) {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  } else {
    path.setAttribute("fill", "currentColor");
  }
  svg.append(path);
  return svg;
}

/** A formula line: plain text, or [tag, text] for an italic, a subscript or a bright figure. Only ever built from literals of this file. */
type Part = string | readonly ["i" | "sub" | "b", string];

function formula(...parts: Part[]): HTMLDivElement {
  const line = make("div");
  for (const part of parts) {
    if (typeof part === "string") line.append(document.createTextNode(part));
    else line.append(make(part[0], "", part[1]));
  }
  return line;
}

/** Set several attributes of an SVG element. */
function attributes<T extends Element>(element: T, values: Record<string, string>): T {
  for (const [name, value] of Object.entries(values)) element.setAttribute(name, value);
  return element;
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Where each floating box sits, in radii of the hole's shadow from its centre (left edge, top edge): at the four corners of the block
 * of lyrics that stands in the middle, so that the words and the figures never meet; the boxes are kept clear of the left panel.
 */
const FLOAT = {
  schwarzschild: { x: -3.2, y: -2.7 },
  speed: { x: 2.2, y: -2.7 },
  mass: { x: -3.2, y: 1.35 },
  orbit: { x: 2.2, y: 1.2 },
} as const;
type FloatKey = keyof typeof FLOAT;

/** Narrower than this (in virtual pixels) the boxes round the hole are left out. */
const FLOAT_MIN_WIDTH = 1000;

export class MusicHud {
  readonly root = make("div", "music-hud");
  private readonly left = make("section", "hud-left");
  private readonly hint = make("div", "hud-hint");
  private readonly capsule = make("footer", "hud-capsule");
  private readonly cover = make("canvas", "hud-cover");
  private readonly thumb = make("canvas", "hud-thumb");
  private readonly title = make("h2", "hud-title");
  private readonly artist = make("p", "hud-artist");
  private readonly chips = make("div", "hud-chips");
  private readonly spectrum = make("div", "hud-spectrum");
  private readonly bars: HTMLElement[] = [];
  private readonly barLevels = new Float32Array(BARS).fill(-1);
  private readonly progress = make("div", "hud-progress");
  private readonly fill = make("i");
  private readonly times = make("span", "hud-times");
  private readonly queueCount = make("em");
  private readonly queueRows = make("ol", "hud-queue-rows");
  private readonly capTitle = make("b");
  private readonly capArtist = make("span");
  private readonly capTime = make("span", "hud-cap-time");
  private readonly capTotal = make("span", "hud-cap-time");
  private readonly capTrack = make("div", "track");
  private readonly capFill = make("i");
  private readonly toggle = make("button", "main");
  private readonly mode = make("button");
  private readonly volume = make("input");
  private readonly floats: Record<FloatKey, HTMLElement> = {
    schwarzschild: make("div", "formula hud-float"),
    mass: make("div", "formula hud-float"),
    orbit: make("div", "formula hud-float hud-orbit"),
    speed: make("div", "formula hud-float"),
  };
  private readonly period = make("b");
  private readonly off: () => void;

  private on = false;
  private floatsOn = false;
  /** How far the archives are out, as last written to the page (0 … 100). */
  private revealNow = -1;
  private coverKey = "";
  private playingNow: boolean | null = null;
  private modeNow: PlayMode | null = null;
  private fillNow = "";
  private timesNow = "";
  /** The place on the track that the pointer holds (0 … 1) while a track of this panel is being dragged. */
  private drag: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly player: MusicPlayer,
    private readonly host: SceneHost,
  ) {
    this.root.dataset.on = "false";
    this.root.dataset.floats = "false";
    this.root.setAttribute("aria-label", "播放面板");

    // The left: cover, title, chips, bars, place in the song, the queue.
    this.cover.width = this.cover.height = 360;
    for (let i = 0; i < BARS; i++) {
      const bar = make("i");
      this.bars.push(bar);
      this.spectrum.append(bar);
    }
    this.progress.append(this.fill);
    this.bindSeek(this.progress);
    const place = make("div", "hud-place");
    place.append(this.progress, this.times);
    const queue = make("div", "hud-queue");
    const head = make("header");
    head.append(make("span", "", "播放列表"), this.queueCount);
    queue.append(head, this.queueRows);
    this.left.append(this.cover, this.title, this.artist, this.chips, this.spectrum, place, queue);

    // The right edge: a hint that the archives are there (they come out when the pointer goes to the right).
    this.hint.setAttribute("aria-hidden", "true");
    this.hint.append(make("i", "", "‹"), make("span", "", "档案"));

    // The bottom capsule.
    this.thumb.width = this.thumb.height = 96;
    const who = make("div", "who");
    who.append(this.capTitle, this.capArtist);
    const button = (name: Icon, label: string, action: () => void) => {
      const element = make("button");
      element.type = "button";
      element.title = label;
      element.setAttribute("aria-label", label);
      element.append(icon(name));
      element.addEventListener("click", action);
      return element;
    };
    this.mode.type = "button";
    this.mode.addEventListener("click", () => this.player.cycleMode());
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => this.player.toggle());
    const controls = make("div", "ctl");
    controls.append(this.mode, button("prev", "上一首", () => this.player.prev()), this.toggle, button("next", "下一首", () => this.player.next()));
    this.capTrack.append(this.capFill);
    this.bindSeek(this.capTrack);
    const bar = make("div", "bar");
    bar.append(this.capTime, this.capTrack, this.capTotal);
    const volume = make("div", "vol");
    this.volume.type = "range";
    this.volume.min = "0";
    this.volume.max = "100";
    this.volume.setAttribute("aria-label", "音量");
    this.volume.addEventListener("input", () => this.player.setVolume(Number(this.volume.value) / 100));
    volume.append(icon("volume"), this.volume);
    this.capsule.append(this.thumb, who, controls, bar, volume);

    // The boxed figures that float round the hole, and the faint coordinates in the corners.
    this.floats.schwarzschild.append(formula(["i", "R"], ["sub", "s"], " = 2", ["i", "GM"], "/", ["i", "c"], "²"));
    this.floats.mass.append(formula(["i", "M"], " = ", ["b", "6.5×10⁹ M☉"]));
    const diagram = attributes(document.createElementNS(SVG, "svg"), { viewBox: "0 0 64 40", "aria-hidden": "true" });
    diagram.append(
      attributes(document.createElementNS(SVG, "ellipse"), { cx: "32", cy: "20", rx: "26", ry: "12", fill: "none", stroke: "currentColor", "stroke-opacity": ".45", "stroke-dasharray": "2 3" }),
      attributes(document.createElementNS(SVG, "circle"), { cx: "32", cy: "20", r: "4.2", fill: "#000", stroke: "currentColor", "stroke-opacity": ".8" }),
      attributes(document.createElementNS(SVG, "circle"), { cx: "55", cy: "14", r: "2.2", fill: "currentColor" }),
    );
    this.floats.orbit.append(diagram, formula(["i", "r"], " = 1.5 ", ["i", "R"], ["sub", "s"]));
    const period = formula(["i", "T"], " = ");
    period.append(this.period);
    this.floats.speed.append(formula(["i", "v"], " = ", ["b", "0.6"], ["i", "c"]), period);
    const coords = make("div", "coords hud-coords");
    coords.append(make("div", "", "R.A. 17h 45m 40s"), make("div", "", "Dec −29° 00′ 28″"));
    const corner = make("div", "coords hud-corner", "Erebus • VITRINE");
    this.root.append(...Object.values(this.floats), this.left, this.hint, this.capsule, coords, corner);
    parent.append(this.root);

    this.off = player.subscribe((change) => this.onPlayer(change));
    this.refreshAll();
  }

  dispose() {
    this.off();
    this.root.remove();
  }

  /** Show or hide the panels (the music page is open or not). */
  show(on: boolean) {
    this.on = on;
    this.root.dataset.on = String(on);
    if (on) this.refreshAll();
  }

  /** Every frame the page is open: the things that move (the bars, the place in the song, the floating boxes). `seeking` is the place the black hole's track is being dragged to. */
  frame(seeking: number | null) {
    if (!this.on) return;
    // Reads first, then writes: the sizes the boxes need are measured before anything below changes the page.
    this.place();
    this.follow();
    const state = this.player.state;
    const known = Boolean(state.song) && state.durationMs > 0;
    const held = this.drag ?? seeking;
    const fraction = held ?? (known ? Math.min(1, state.positionMs / state.durationMs) : 0);
    const width = `${((known ? fraction : 0) * 100).toFixed(1)}%`;
    if (width !== this.fillNow) {
      this.fillNow = width;
      this.fill.style.width = width;
      this.capFill.style.width = width;
      const now = String(Math.round(fraction * 100));
      this.progress.setAttribute("aria-valuenow", now);
      this.capTrack.setAttribute("aria-valuenow", now);
    }
    const at = !known ? 0 : held !== null ? held * state.durationMs : state.positionMs;
    const times = `${clock(at)} / ${clock(state.durationMs)}`;
    if (times !== this.timesNow) {
      this.timesNow = times;
      this.times.textContent = times;
      this.capTime.textContent = clock(at);
    }
    // The bars are the bands of the spectrum (the player keeps them: the real ones, a made-up groove without access to the audio, or at rest).
    const spectrum = this.player.spectrum;
    for (let i = 0; i < BARS; i++) {
      const level = 0.08 + 0.92 * clamp(spectrum.at(i / (BARS - 1)), 0, 1);
      if (Math.abs(level - this.barLevels[i]) < BAR_STEP) continue;
      this.barLevels[i] = level;
      this.bars[i].style.transform = `scaleY(${level.toFixed(3)})`;
    }
  }

  /** The floating boxes sit by the hole, wherever it is on the picture (it moves when the player drags and zooms the view). */
  private place() {
    const stage = this.host.stage;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const spot = stage && width > 0 ? stage.holeScreen(width, height) : null;
    const wide = spot !== null && width >= FLOAT_MIN_WIDTH;
    if (wide !== this.floatsOn) {
      this.floatsOn = wide;
      this.root.dataset.floats = String(wide);
    }
    if (!wide || !spot) return;
    // Keep the boxes clear of the left panel and the edge …
    const min = this.left.offsetLeft + this.left.offsetWidth + 14;
    const max = width - 52;
    // … below the control rail's tabs at the top, and clear of the capsule at the bottom (a short window brings the capsule up).
    const top = Math.max(136, height * 0.17);
    const lid = this.capsule.offsetTop - 14;
    for (const key of Object.keys(FLOAT) as FloatKey[]) {
      const element = this.floats[key];
      const bottom = Math.min(height * 0.7, lid - element.offsetHeight);
      const x = clamp(spot.x + FLOAT[key].x * spot.radius, min, Math.max(min, max - element.offsetWidth));
      const y = clamp(spot.y + FLOAT[key].y * spot.radius, top, Math.max(top, bottom));
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  /** Tell the page how far the archives are out (the left panel, the boxes and the hint give way as the camera moves aside). */
  private follow() {
    const amount = Math.round((this.host.stage?.revealAmount ?? 0) * 100);
    if (amount === this.revealNow) return;
    this.revealNow = amount;
    this.root.style.setProperty("--reveal", (amount / 100).toFixed(2));
    this.root.dataset.out = String(amount > 50);
  }

  // ───────────────────────────────────────────── the player's changes ─────────────────────────────────────────────

  private onPlayer(change: PlayerChange) {
    if (!this.on) return;
    if (change === "song" || change === "cover" || change === "queue") this.refreshSong();
    if (change === "song" || change === "play" || change === "mode" || change === "volume" || change === "loading" || change === "error") this.refreshControls();
  }

  private refreshAll() {
    this.refreshSong();
    this.refreshControls();
  }

  private refreshSong() {
    const { song, cover, trial } = this.player.state;
    const artists = song ? song.artists.join(" / ") || "未知歌手" : "点黑洞，或选一张档案，开始";
    this.title.textContent = song ? song.name : "还没有在播放的歌";
    this.artist.textContent = artists;
    this.capTitle.textContent = song ? song.name : "Vitrine 音乐";
    this.capArtist.textContent = song ? artists : "点黑洞开始";
    this.capsule.dataset.idle = String(!song);
    this.capTotal.textContent = clock(song?.durationMs ?? 0);
    this.period.textContent = song ? clock(song.durationMs) : "--:--";
    this.timesNow = "";
    // The chips: the album, and a note when the service plays only a preview or the song is for members.
    this.chips.replaceChildren();
    const chips = song ? [song.album, trial ? "试听片段" : "", song.fee === 1 ? "会员" : ""].filter(Boolean) : [];
    for (const chip of chips.slice(0, 3)) this.chips.append(make("span", "", chip));
    // The queue: a window of three songs that holds the current one.
    const songs = this.player.queue.songs;
    const current = this.player.queue.index;
    this.queueCount.textContent = songs.length ? `${Math.max(0, current) + 1}/${songs.length}` : "0/0";
    this.queueRows.replaceChildren();
    const first = clamp(current - 1, 0, Math.max(0, songs.length - 3));
    for (let at = first; at < Math.min(songs.length, first + 3); at++) {
      const item = make("li", at === current ? "now" : "");
      item.append(make("span", "n", String(at + 1).padStart(2, "0")), make("span", "t", songs[at].name), make("span", "a", songs[at].artists[0] ?? ""));
      this.queueRows.append(item);
    }
    if (!songs.length) this.queueRows.append(make("li", "empty", "从一张歌单里选一首歌，列表会出现在这里"));
    // The cover (and the little one in the capsule) is drawn again only when it is a different picture.
    const key = `${song?.id ?? 0}:${cover ? "1" : "0"}`;
    if (key !== this.coverKey) {
      this.coverKey = key;
      this.drawCover(this.cover, cover);
      this.drawCover(this.thumb, cover);
    }
  }

  private drawCover(canvas: HTMLCanvasElement, image: CanvasImageSource | null) {
    const context = canvas.getContext("2d");
    if (!context) return;
    const size = canvas.width;
    context.clearRect(0, 0, size, size);
    const gradient = context.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#2a1d0e");
    gradient.addColorStop(1, "#0a0806");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    if (!image) {
      context.fillStyle = "rgba(240,190,110,.75)";
      context.font = `${Math.round(size * 0.42)}px "LXGW WenKai", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("♪", size / 2, size / 2 + size * 0.03);
      return;
    }
    const source = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const w = source.naturalWidth || source.width || size;
    const h = source.naturalHeight || source.height || size;
    const side = Math.min(w, h);
    try {
      context.drawImage(image, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    } catch {
      // A picture that cannot be drawn (not decoded yet) leaves the gradient.
    }
  }

  // ───────────────────────────────────────────── the controls ─────────────────────────────────────────────

  private refreshControls() {
    const { playing, mode, volume, loading } = this.player.state;
    if (playing !== this.playingNow) {
      this.playingNow = playing;
      this.toggle.replaceChildren(icon(playing ? "pause" : "play"));
      this.toggle.title = playing ? "暂停" : "播放";
      this.toggle.setAttribute("aria-label", playing ? "暂停" : "播放");
    }
    this.capsule.dataset.loading = String(loading);
    if (mode !== this.modeNow) {
      this.modeNow = mode;
      this.mode.replaceChildren(icon(mode === "shuffle" ? "shuffle" : mode === "single" ? "single" : mode === "loop" ? "loop" : "order"));
      this.mode.title = MODE_LABEL[mode];
      this.mode.setAttribute("aria-label", MODE_LABEL[mode]);
    }
    if (document.activeElement !== this.volume) this.volume.value = String(Math.round(volume * 100));
  }

  /** A track that is pressed or dragged shows the place at once and jumps there when it is let go. */
  private bindSeek(track: HTMLElement) {
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", "播放进度");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.tabIndex = 0;
    const fractionOf = (event: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    };
    track.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.player.state.song) return;
      track.setPointerCapture(event.pointerId);
      this.drag = fractionOf(event);
      event.preventDefault();
    });
    track.addEventListener("pointermove", (event) => {
      if (this.drag !== null) this.drag = fractionOf(event);
    });
    const end = (event: PointerEvent, commit: boolean) => {
      if (this.drag === null) return;
      const value = fractionOf(event);
      this.drag = null;
      if (commit) this.player.seekFraction(value);
    };
    track.addEventListener("pointerup", (event) => end(event, true));
    track.addEventListener("pointercancel", (event) => end(event, false));
    track.addEventListener("keydown", (event) => {
      if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || !this.player.state.song) return;
      event.preventDefault();
      event.stopPropagation();
      this.player.seekTo(this.player.state.positionMs + (event.key === "ArrowRight" ? 5000 : -5000));
    });
  }
}
