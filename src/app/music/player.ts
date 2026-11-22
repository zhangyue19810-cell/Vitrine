import { SPECTRUM_BANDS, Spectrum, bandEdges, groupBins } from "../../spectrum";
import type { LyricLine, MusicLyrics, MusicSong, MusicSource } from "../types";
import { PlayQueue, PLAY_MODES, type PlayMode } from "./queue";

/**
 * The music player: a queue, one audio element, and what the interface needs to draw about them. It is created once and
 * lives as long as the page, so the music goes on while the player browses; every view only looks at its state.
 *
 * Nothing here draws or touches the network directly: the audio element, the loudness meter and the backend are handed
 * in (so the logic is tested with fakes), and changes are announced to subscribers. Values that change every frame (the
 * position, the loudness) are not announced; `tick()` refreshes them and the scene's frame loop reads them.
 */

export interface AudioLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  volume: number;
  crossOrigin: string | null;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

export interface MusicBackend {
  source(id: number): Promise<MusicSource | null>;
  lyrics(id: number): Promise<MusicLyrics>;
  /** A cover as a data URL (the core fetches it: the page may not read pixels of other origins). */
  cover(url: string): Promise<string | null>;
}

/** Measures the music right now. Present only when the browser lets the page read the audio. */
export interface Meter {
  /** How loud it is, 0…1. */
  level(): number;
  /** The loudness of each of the spectrum's bands, 0…1 (low to high). Without it the scene dances to a made-up groove. */
  bands?(out: Float32Array): void;
  resume(): void;
}

export interface PlayerOptions {
  audio: AudioLike;
  backend: MusicBackend;
  /** Make the meter for the audio element (called once, after the first successful start with cross-origin access). */
  meter?: (audio: AudioLike) => Meter | undefined;
  loadImage?: (dataUrl: string) => Promise<CanvasImageSource | null>;
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  random?: () => number;
  /** Called (debounced by the caller) when the volume or the mode changed. */
  persist?: (patch: { volume?: number; mode?: PlayMode }) => void;
  initial?: { volume: number; mode: PlayMode };
  now?: () => number;
}

export interface PlayerState {
  song?: MusicSong;
  index: number;
  count: number;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  mode: PlayMode;
  error: string;
  /** The service plays only a short preview of this song for this account. */
  trial: boolean;
  lyrics?: MusicLyrics;
  lyricIndex: number;
  cover: CanvasImageSource | null;
  /** 0…1, smoothed. */
  level: number;
  /** Paused by the launcher (a game runs), to carry on when it closes. */
  suspended: boolean;
}

export type PlayerChange = "song" | "play" | "queue" | "mode" | "volume" | "lyrics" | "lyric" | "cover" | "error" | "loading";

const STORE_KEY = "vitrine.music.queue";
const STORE_MAX = 300;

export class MusicPlayer {
  readonly queue: PlayQueue;
  readonly state: PlayerState;
  /** The music's frequency bands, for the scene: the archives jump with them. */
  readonly spectrum = new Spectrum();
  private readonly raw = new Float32Array(SPECTRUM_BANDS);
  private readonly audio: AudioLike;
  private readonly listeners = new Set<(change: PlayerChange) => void>();
  private token = 0;
  private failures = 0;
  private corsOk = true;
  private meter?: Meter;
  private meterTried = false;
  private covers = new Map<string, CanvasImageSource | null>();
  private resumeAfter = false;
  private lastSave = 0;
  private pendingSeek: number | null = null;
  private fake = 0;

  constructor(private readonly options: PlayerOptions) {
    this.audio = options.audio;
    const initial = options.initial ?? { volume: 0.6, mode: "loop" as PlayMode };
    this.queue = new PlayQueue(initial.mode, options.random);
    this.state = {
      index: -1,
      count: 0,
      playing: false,
      loading: false,
      positionMs: 0,
      durationMs: 0,
      volume: initial.volume,
      mode: initial.mode,
      error: "",
      trial: false,
      lyricIndex: -1,
      cover: null,
      level: 0,
      suspended: false,
    };
    this.audio.volume = initial.volume;
    this.audio.crossOrigin = "anonymous";
    this.audio.addEventListener("ended", () => this.onEnded());
    this.audio.addEventListener("error", () => this.onError());
    this.audio.addEventListener("playing", () => this.onPlaying());
    this.audio.addEventListener("pause", () => this.onPause());
    this.audio.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) this.state.durationMs = this.audio.duration * 1000;
      if (this.pendingSeek !== null) {
        this.audio.currentTime = this.pendingSeek / 1000;
        this.pendingSeek = null;
      }
    });
    this.restore();
  }

  subscribe(listener: (change: PlayerChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: PlayerChange) {
    for (const listener of this.listeners) listener(change);
  }

  get current(): MusicSong | undefined {
    return this.queue.current;
  }

  // ------------------------------------------------------------------------------------------ starting songs

  /** Play `songs` from `start` (a playlist was opened and a song, or "play all", was chosen). */
  playList(songs: MusicSong[], start = 0) {
    const playable = songs.map((song, index) => ({ song, index })).filter((entry) => !entry.song.unavailable);
    if (!playable.length) return this.fail("这个列表里的歌曲暂时都无法播放");
    const wanted = playable.find((entry) => entry.index >= start) ?? playable[0];
    this.queue.set(playable.map((entry) => entry.song), playable.indexOf(wanted));
    this.afterQueueChange();
    void this.startCurrent();
  }

  /** Play one song at once; the rest of the queue stays behind it. */
  playNow(song: MusicSong) {
    const known = this.queue.songs.findIndex((entry) => entry.id === song.id);
    if (known >= 0) this.queue.jump(known);
    else {
      this.queue.insertNext(song);
      this.queue.jump(this.queue.songs.findIndex((entry) => entry.id === song.id));
    }
    this.afterQueueChange();
    void this.startCurrent();
  }

  playNext(song: MusicSong) {
    if (!this.queue.length) return this.playNow(song);
    this.queue.insertNext(song);
    this.afterQueueChange();
  }

  private afterQueueChange() {
    this.state.count = this.queue.length;
    this.state.index = this.queue.index;
    this.emit("queue");
    this.save();
  }

  private async startCurrent(resumeAt = 0, note = "") {
    const song = this.queue.current;
    if (!song) return;
    const token = ++this.token;
    this.spectrum.forget();
    this.state.song = song;
    this.state.index = this.queue.index;
    this.state.error = note;
    this.state.loading = true;
    this.state.trial = false;
    this.state.lyrics = undefined;
    this.state.lyricIndex = -1;
    this.state.positionMs = resumeAt;
    this.state.durationMs = song.durationMs;
    this.state.cover = this.covers.get(song.cover) ?? null;
    this.emit("song");
    this.emit("loading");
    this.ensureCover(song);
    void this.ensureLyrics(song, token);
    let source: MusicSource | null;
    try {
      source = await this.options.backend.source(song.id);
    } catch (error) {
      if (token === this.token) this.skipOrStop((error as Error).message);
      return;
    }
    if (token !== this.token) return;
    if (!source) return this.skipOrStop("这首歌暂时无法播放（没有版权，或需要会员）");
    this.state.trial = source.trial;
    if (resumeAt > 0) this.pendingSeek = resumeAt;
    await this.load(source.url, token);
  }

  private async load(url: string, token: number) {
    this.audio.src = url;
    try {
      await this.audio.play();
    } catch (error) {
      if (token !== this.token) return;
      const name = (error as Error).name;
      if (name === "NotAllowedError") {
        // The browser wants a click first (the queue was restored, or a key started it): wait for one.
        this.state.loading = false;
        this.state.playing = false;
        this.emit("loading");
        this.emit("play");
      }
      // Any other failure (the resource cannot be loaded) also fires the element's "error" event, which is handled there.
    }
  }

  private skipOrStop(message: string) {
    this.state.loading = false;
    this.failures++;
    this.emit("loading");
    if (this.failures < Math.min(5, Math.max(1, this.queue.length)) && this.queue.length > 1) {
      const next = this.queue.advance();
      if (next >= 0 && this.queue.current?.id !== this.state.song?.id) {
        void this.startCurrent(0, `${message}，已跳到下一首`);
        return;
      }
    }
    this.fail(message);
  }

  private fail(message: string) {
    this.failures = 0;
    this.state.playing = false;
    this.state.loading = false;
    this.state.error = message;
    this.emit("error");
    this.emit("play");
  }

  // ------------------------------------------------------------------------------------------ the audio element's events

  private onPlaying() {
    this.failures = 0;
    this.state.loading = false;
    this.state.playing = true;
    this.state.error = this.state.error.endsWith("已跳到下一首") ? this.state.error : "";
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) this.state.durationMs = this.audio.duration * 1000;
    if (!this.meterTried && this.corsOk && this.options.meter) {
      this.meterTried = true;
      try {
        this.meter = this.options.meter(this.audio);
      } catch {
        this.meter = undefined;
      }
    }
    this.meter?.resume();
    this.emit("loading");
    this.emit("play");
    this.updateMediaSession();
  }

  private onPause() {
    if (this.audio.currentTime >= (this.audio.duration || Infinity)) return; // the end is handled by "ended"
    if (this.state.loading && !this.state.playing) return;
    this.state.playing = false;
    this.emit("play");
    this.save(true);
  }

  private onEnded() {
    this.state.playing = false;
    const next = this.queue.advance();
    if (next < 0) {
      this.state.positionMs = 0;
      this.audio.currentTime = 0;
      this.emit("play");
      return;
    }
    void this.startCurrent();
  }

  private onError() {
    const song = this.state.song;
    if (!song) return;
    if (this.corsOk && this.audio.crossOrigin && !this.state.playing && this.audio.src) {
      // The server did not allow cross-origin reading (a plain browser rather than the app): play without the meter.
      this.corsOk = false;
      this.audio.removeAttribute("crossorigin");
      this.audio.crossOrigin = null;
      const url = this.audio.src;
      this.audio.src = url;
      void this.audio.play().catch(() => undefined);
      return;
    }
    this.skipOrStop("这首歌加载失败，可能是网络不稳定或链接已过期");
  }

  // ------------------------------------------------------------------------------------------ controls

  toggle() {
    if (!this.queue.current) return;
    if (this.state.playing || this.state.loading) {
      this.token++; // a source that is still on its way must not start the song again
      this.state.loading = false;
      this.audio.pause();
      this.state.playing = false;
      this.emit("play");
      this.save(true);
    } else if (this.audio.src && !this.state.error) {
      this.state.error = "";
      void this.audio.play().catch(() => undefined);
    } else {
      this.failures = 0;
      void this.startCurrent(this.state.positionMs);
    }
  }

  pause() {
    if (this.state.playing || this.state.loading) this.toggle();
  }

  next() {
    const index = this.queue.next();
    if (index < 0) return;
    this.failures = 0;
    void this.startCurrent();
  }

  /** "Previous": a song that has played for a few seconds starts again, otherwise the one before it comes. */
  prev() {
    if (this.audio.currentTime > 3 || !this.queue.length) {
      this.seekTo(0);
      return;
    }
    const index = this.queue.prev();
    if (index < 0) return this.seekTo(0);
    this.failures = 0;
    void this.startCurrent();
  }

  /** Seek to a fraction of the song (0…1). */
  seekFraction(fraction: number) {
    const duration = this.state.durationMs || this.queue.current?.durationMs || 0;
    if (duration > 0) this.seekTo(Math.min(0.999, Math.max(0, fraction)) * duration);
  }

  seekTo(ms: number) {
    this.state.positionMs = Math.max(0, ms);
    if (this.audio.src && !this.state.loading) this.audio.currentTime = this.state.positionMs / 1000;
    else this.pendingSeek = this.state.positionMs;
  }

  setVolume(volume: number) {
    const value = Math.min(1, Math.max(0, volume));
    if (value === this.state.volume) return;
    this.state.volume = value;
    this.audio.volume = value;
    this.emit("volume");
    this.options.persist?.({ volume: value });
  }

  nudgeVolume(direction: number) {
    this.setVolume(Math.round((this.state.volume + direction * 0.05) * 100) / 100);
  }

  setMode(mode: PlayMode) {
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    this.queue.setMode(mode);
    this.emit("mode");
    this.options.persist?.({ mode });
  }

  cycleMode() {
    this.setMode(PLAY_MODES[(PLAY_MODES.indexOf(this.state.mode) + 1) % PLAY_MODES.length]);
  }

  /** A game started: pause (and remember whether to carry on); it closed: carry on. */
  suspend(suspended: boolean) {
    if (suspended === this.state.suspended) return;
    this.state.suspended = suspended;
    if (suspended) {
      this.resumeAfter = this.state.playing;
      if (this.state.playing) this.toggle();
    } else if (this.resumeAfter) {
      this.resumeAfter = false;
      this.toggle();
    }
  }

  // ------------------------------------------------------------------------------------------ covers and lyrics

  /** The decoded cover of a song when it is here (it is fetched in the background; "cover" is announced when it arrives). */
  coverOf(song: MusicSong | undefined): CanvasImageSource | null | undefined {
    if (!song?.cover) return null;
    return this.covers.get(song.cover);
  }

  ensureCover(song: MusicSong) {
    const url = song.cover;
    if (!url || this.covers.has(url)) return;
    this.covers.set(url, null);
    void (async () => {
      try {
        const data = await this.options.backend.cover(url);
        const image = data && this.options.loadImage ? await this.options.loadImage(data) : null;
        this.covers.set(url, image);
        if (this.covers.size > 120) this.covers.delete(this.covers.keys().next().value as string);
        if (this.state.song?.cover === url) {
          this.state.cover = image;
          this.emit("cover");
          this.updateMediaSession(data ?? undefined);
        } else this.emit("cover");
      } catch {
        /* the plain label stays */
      }
    })();
  }

  private async ensureLyrics(song: MusicSong, token: number) {
    try {
      const lyrics = await this.options.backend.lyrics(song.id);
      if (token !== this.token) return;
      this.state.lyrics = lyrics;
      this.state.lyricIndex = lyrics.timed ? lineIndex(lyrics.lines, this.state.positionMs) : -1;
      this.emit("lyrics");
    } catch {
      /* no lyrics is fine */
    }
  }

  // ------------------------------------------------------------------------------------------ every frame

  /** Refresh position, lyric line and loudness. Returns true when the lyric line changed. */
  tick(dt: number): boolean {
    const playing = this.state.playing;
    if (this.state.song && !this.state.loading && this.audio.src) {
      const position = this.audio.currentTime * 1000;
      if (Number.isFinite(position) && (playing || Math.abs(position - this.state.positionMs) > 400)) this.state.positionMs = position;
    }
    let target = 0;
    if (playing) {
      const meter = this.meter;
      if (meter?.bands) {
        // The real thing: the spectrum of what is coming out of the speakers.
        meter.bands(this.raw);
        this.spectrum.feed(this.raw, dt);
        target = Math.min(1, this.spectrum.energy * 2.4 + this.spectrum.beat * 0.15);
      } else {
        if (meter) target = meter.level();
        else {
          // No access to the audio itself (a plain browser): a gentle pulse so that the scene still breathes with the music.
          this.fake += dt;
          target = 0.38 + 0.22 * Math.sin(this.fake * 6.1) * Math.sin(this.fake * 1.7 + 1) + 0.1 * Math.sin(this.fake * 13.7);
        }
        this.spectrum.synth(dt);
      }
    } else this.spectrum.release(dt);
    const rate = target > this.state.level ? 14 : 5;
    this.state.level += (Math.min(1, Math.max(0, target)) - this.state.level) * (1 - Math.exp(-rate * Math.min(dt, 0.1)));
    if (this.state.level < 0.002 && target === 0) this.state.level = 0;
    const lyrics = this.state.lyrics;
    if (lyrics?.timed) {
      const index = lineIndex(lyrics.lines, this.state.positionMs);
      if (index !== this.state.lyricIndex) {
        this.state.lyricIndex = index;
        this.emit("lyric");
        return true;
      }
    }
    if (playing) this.save();
    return false;
  }

  /** Fraction played (0…1), or null while the length is not known. */
  get progress(): number | null {
    const duration = this.state.durationMs;
    if (!this.state.song || !(duration > 0)) return null;
    return Math.min(1, this.state.positionMs / duration);
  }

  /** The lyric lines around the current one for a printed face. */
  lyricWindow(before = 2, after = 2): { lines: LyricLine[]; current: number } | undefined {
    const lyrics = this.state.lyrics;
    if (!lyrics || !lyrics.lines.length) return undefined;
    if (!lyrics.timed) return { lines: lyrics.lines.slice(0, before + after + 1), current: -1 };
    const at = Math.max(0, this.state.lyricIndex);
    const start = Math.max(0, Math.min(at - before, lyrics.lines.length - (before + after + 1)));
    const lines = lyrics.lines.slice(start, start + before + after + 1);
    return { lines, current: this.state.lyricIndex < 0 ? -1 : this.state.lyricIndex - start };
  }

  // ------------------------------------------------------------------------------------------ remembering

  private save(force = false) {
    const now = (this.options.now ?? Date.now)();
    if (!force && now - this.lastSave < 15_000) return;
    this.lastSave = now;
    try {
      const songs = this.queue.songs.slice(0, STORE_MAX);
      this.options.storage?.setItem(STORE_KEY, JSON.stringify({ songs, index: Math.min(this.queue.index, songs.length - 1), position: Math.round(this.state.positionMs) }));
    } catch {
      /* private mode, or the quota: the queue is simply not remembered */
    }
  }

  private restore() {
    try {
      const raw = this.options.storage?.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { songs?: MusicSong[]; index?: number; position?: number };
      if (!Array.isArray(saved.songs) || !saved.songs.length) return;
      const songs = saved.songs.filter((song) => song && typeof song.id === "number" && typeof song.name === "string");
      if (!songs.length) return;
      this.queue.set(songs, Math.min(Math.max(0, saved.index ?? 0), songs.length - 1));
      this.state.count = songs.length;
      this.state.index = this.queue.index;
      this.state.song = this.queue.current;
      this.state.durationMs = this.queue.current?.durationMs ?? 0;
      this.state.positionMs = typeof saved.position === "number" ? saved.position : 0;
      if (this.queue.current) this.ensureCover(this.queue.current);
    } catch {
      /* a damaged entry is ignored */
    }
  }

  private updateMediaSession(art?: string) {
    const song = this.state.song;
    const session = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession : undefined;
    if (!song || !session || typeof MediaMetadata === "undefined") return;
    try {
      session.metadata = new MediaMetadata({ title: song.name, artist: song.artists.join(" / "), album: song.album, artwork: art ? [{ src: art, sizes: "256x256" }] : [] });
      session.playbackState = this.state.playing ? "playing" : "paused";
    } catch {
      /* not supported here */
    }
  }

  /** Let the keyboard's media keys control the player. */
  bindMediaKeys() {
    const session = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession : undefined;
    if (!session) return;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* an action this browser does not know */
      }
    };
    set("play", () => !this.state.playing && this.toggle());
    set("pause", () => this.pause());
    set("previoustrack", () => this.prev());
    set("nexttrack", () => this.next());
    set("seekto", (details) => details.seekTime !== undefined && this.seekTo(details.seekTime * 1000));
  }
}

/** Index of the last lyric line that starts at or before `ms` (−1 before the first). */
export function lineIndex(lines: readonly LyricLine[], ms: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].t <= ms) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/** The meter of a real audio element (Web Audio): the loudness of the low and middle range, and the spectrum in bands. */
export function webAudioMeter(audio: AudioLike): Meter | undefined {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return undefined;
  const context = new Context();
  const source = context.createMediaElementSource(audio as unknown as HTMLMediaElement);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  // Light smoothing: the spectrum does its own (fast up, slow down), so that a drum hit is not blurred before it gets there.
  analyser.smoothingTimeConstant = 0.55;
  analyser.minDecibels = -88;
  analyser.maxDecibels = -22;
  source.connect(analyser);
  analyser.connect(context.destination);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const edges = bandEdges(SPECTRUM_BANDS, bins.length, context.sampleRate);
  return {
    level() {
      analyser.getByteFrequencyData(bins);
      let sum = 0;
      const count = Math.min(160, bins.length);
      for (let i = 1; i < count; i++) sum += bins[i];
      return Math.min(1, (sum / (count - 1) / 255) * 1.9);
    },
    bands(out) {
      analyser.getByteFrequencyData(bins);
      groupBins(bins, edges, out);
    },
    resume() {
      if (context.state === "suspended") void context.resume();
    },
  };
}
