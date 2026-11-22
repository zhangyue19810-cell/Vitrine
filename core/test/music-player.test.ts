import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MusicPlayer, lineIndex, type AudioLike, type Meter, type MusicBackend, type PlayerOptions } from "../../src/app/music/player";
import type { MusicLyrics, MusicSong } from "../../src/app/types";

const song = (id: number, extra: Partial<MusicSong> = {}): MusicSong => ({ id, name: `s${id}`, artists: ["a"], album: "al", cover: `https://c/${id}.png`, durationMs: 100_000, fee: 0, unavailable: false, ...extra });
const songs = (count: number) => Array.from({ length: count }, (_, i) => song(i + 1));
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeAudio extends EventTarget implements AudioLike {
  src = "";
  currentTime = 0;
  duration = NaN;
  paused = true;
  volume = 1;
  crossOrigin: string | null = null;
  removed: string[] = [];
  plays: string[] = [];
  /** URLs for which the next play() fails like a server without CORS headers. */
  corsFail = new Set<string>();
  blocked = false;

  play(): Promise<void> {
    this.plays.push(this.src);
    if (this.blocked) return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    if (this.crossOrigin && this.corsFail.has(this.src)) {
      queueMicrotask(() => this.dispatchEvent(new Event("error")));
      return Promise.reject(Object.assign(new Error("failed"), { name: "NotSupportedError" }));
    }
    this.paused = false;
    queueMicrotask(() => {
      this.duration = 100;
      this.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("playing"));
    });
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  load() {}
  removeAttribute(name: string) {
    this.removed.push(name);
  }
  finish() {
    this.currentTime = this.duration;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

function setup(overrides: Partial<PlayerOptions> = {}, backend: Partial<MusicBackend> = {}) {
  const audio = new FakeAudio();
  const calls = { source: [] as number[], lyrics: [] as number[], cover: [] as string[], persist: [] as object[] };
  const lyrics: MusicLyrics = { lines: [{ t: 0, text: "a" }, { t: 5000, text: "b" }, { t: 10_000, text: "c" }, { t: 15_000, text: "d" }, { t: 20_000, text: "e" }, { t: 25_000, text: "f" }], timed: true, instrumental: false, hasTranslation: false };
  const full: MusicBackend = {
    source: async (id) => {
      calls.source.push(id);
      return { url: `http://cdn/${id}.mp3`, bitrate: 320000, trial: false };
    },
    lyrics: async (id) => {
      calls.lyrics.push(id);
      return lyrics;
    },
    cover: async (url) => {
      calls.cover.push(url);
      return "data:image/png;base64,AAAA";
    },
    ...backend,
  };
  const store = new Map<string, string>();
  const player = new MusicPlayer({
    audio,
    backend: full,
    loadImage: async () => ({}) as CanvasImageSource,
    storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) },
    persist: (patch) => calls.persist.push(patch),
    random: () => 0.5,
    ...overrides,
  });
  return { audio, player, calls, store, lyrics };
}

describe("music player", () => {
  it("plays a list from the chosen song, asks for its address, lyrics and cover once, and reports playing", async () => {
    const { audio, player, calls } = setup();
    player.playList(songs(3), 1);
    assert.equal(player.state.loading, true);
    await tick();
    assert.deepEqual(calls.source, [2]);
    assert.deepEqual(calls.lyrics, [2]);
    assert.deepEqual(calls.cover, ["https://c/2.png"]);
    assert.equal(audio.src, "http://cdn/2.mp3");
    assert.equal(player.state.playing, true);
    assert.equal(player.state.loading, false);
    assert.equal(player.state.durationMs, 100_000);
    assert.equal(player.state.song?.id, 2);
    assert.equal(player.state.index, 1);
    assert.equal(audio.crossOrigin, "anonymous");
    assert.ok(player.state.cover, "the cover arrived");
  });

  it("goes on to the next song when one ends (loop wraps, order stops)", async () => {
    const loop = setup({ initial: { volume: 0.5, mode: "loop" } });
    loop.player.playList(songs(2), 1);
    await tick();
    loop.audio.finish();
    await tick();
    assert.equal(loop.player.state.song?.id, 1);
    assert.equal(loop.player.state.playing, true);

    const order = setup({ initial: { volume: 0.5, mode: "order" } });
    order.player.playList(songs(2), 1);
    await tick();
    order.audio.finish();
    await tick();
    assert.equal(order.player.state.playing, false);
    assert.equal(order.player.state.song?.id, 2);
    assert.equal(order.audio.currentTime, 0);
  });

  it("single mode repeats the song that ends", async () => {
    const { audio, player, calls } = setup({ initial: { volume: 0.5, mode: "single" } });
    player.playList(songs(3), 0);
    await tick();
    audio.finish();
    await tick();
    assert.deepEqual(calls.source, [1, 1]);
  });

  it("leaves unavailable songs out of the queue", async () => {
    const { player, calls } = setup();
    player.playList([song(1, { unavailable: true }), song(2), song(3, { unavailable: true }), song(4)], 0);
    await tick();
    assert.deepEqual(player.queue.songs.map((entry) => entry.id), [2, 4]);
    assert.deepEqual(calls.source, [2]);
    const none = setup();
    none.player.playList([song(1, { unavailable: true })], 0);
    assert.match(none.player.state.error, /都无法播放/);
  });

  it("a song without an address is skipped with a note; when every song fails it stops with the reason", async () => {
    const { player, calls } = setup({}, { source: async (id) => (id === 2 ? null : { url: `http://cdn/${id}.mp3`, bitrate: 0, trial: false }) });
    player.playList(songs(3), 1);
    await tick();
    await tick();
    assert.equal(player.state.song?.id, 3);
    assert.match(player.state.error, /已跳到下一首/);
    assert.equal(player.state.playing, true);

    const dead = setup({}, { source: async () => null });
    dead.player.playList(songs(4), 0);
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(dead.player.state.playing, false);
    assert.match(dead.player.state.error, /无法播放/);
    assert.ok(dead.calls.source.length <= 5, `tried ${dead.calls.source.length}`);
  });

  it("a server that refuses cross-origin reading is played without the meter, once, and the choice is remembered", async () => {
    const { audio, player } = setup();
    audio.corsFail.add("http://cdn/1.mp3");
    player.playList(songs(2), 0);
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(audio.crossOrigin, null);
    assert.deepEqual(audio.removed, ["crossorigin"]);
    assert.equal(player.state.playing, true);
    assert.equal(player.state.song?.id, 1);
  });

  it("a preview-only song is marked as such", async () => {
    const { player } = setup({}, { source: async () => ({ url: "http://cdn/x.mp3", bitrate: 128000, trial: true }) });
    player.playList(songs(1), 0);
    await tick();
    assert.equal(player.state.trial, true);
  });

  it("pause and resume; pausing while the address is still on its way keeps the song from starting", async () => {
    const { audio, player } = setup();
    player.playList(songs(2), 0);
    await tick();
    player.toggle();
    assert.equal(player.state.playing, false);
    assert.equal(audio.paused, true);
    player.toggle();
    await tick();
    assert.equal(player.state.playing, true);

    let release!: () => void;
    const slow = setup({}, { source: () => new Promise((resolve) => (release = () => resolve({ url: "http://cdn/slow.mp3", bitrate: 0, trial: false }))) });
    slow.player.playList(songs(1), 0);
    slow.player.toggle();
    release();
    await tick();
    assert.equal(slow.audio.src, "", "it never started");
    assert.equal(slow.player.state.playing, false);
  });

  it("an autoplay block leaves the song ready to start with a click", async () => {
    const { audio, player } = setup();
    audio.blocked = true;
    player.playList(songs(1), 0);
    await tick();
    assert.equal(player.state.playing, false);
    assert.equal(player.state.loading, false);
    audio.blocked = false;
    player.toggle();
    await tick();
    assert.equal(player.state.playing, true);
  });

  it("'previous' restarts a song that has played for a while, otherwise goes back", async () => {
    const { audio, player } = setup();
    player.playList(songs(3), 1);
    await tick();
    audio.currentTime = 10;
    player.prev();
    assert.equal(audio.currentTime, 0);
    assert.equal(player.state.song?.id, 2);
    player.prev();
    await tick();
    assert.equal(player.state.song?.id, 1);
  });

  it("seeking by fraction uses the song's length, and a seek before the audio has loaded is applied when it has", async () => {
    const { audio, player } = setup();
    player.playList(songs(1), 0);
    await tick();
    player.seekFraction(0.25);
    assert.equal(audio.currentTime, 25);
    player.seekFraction(5);
    assert.ok(audio.currentTime < 100, "never past the end");
  });

  it("volume is clamped, announced and handed on to be stored; 'nudge' moves in steps of five percent", () => {
    const { audio, player, calls } = setup({ initial: { volume: 0.6, mode: "loop" } });
    const changes: string[] = [];
    player.subscribe((change) => changes.push(change));
    player.setVolume(1.7);
    assert.equal(player.state.volume, 1);
    assert.equal(audio.volume, 1);
    player.nudgeVolume(-1);
    assert.equal(player.state.volume, 0.95);
    player.setVolume(-2);
    assert.equal(player.state.volume, 0);
    assert.deepEqual(calls.persist, [{ volume: 1 }, { volume: 0.95 }, { volume: 0 }]);
    assert.deepEqual(changes, ["volume", "volume", "volume"]);
  });

  it("the play mode cycles through all four and is stored", () => {
    const { player, calls } = setup({ initial: { volume: 0.6, mode: "order" } });
    const seen = [player.state.mode];
    for (let i = 0; i < 4; i++) {
      player.cycleMode();
      seen.push(player.state.mode);
    }
    assert.deepEqual(seen, ["order", "loop", "single", "shuffle", "order"]);
    assert.equal(calls.persist.length, 4);
  });

  it("a running game pauses the music and its end carries on, but only if it was playing", async () => {
    const { audio, player } = setup();
    player.playList(songs(2), 0);
    await tick();
    player.suspend(true);
    assert.equal(audio.paused, true);
    assert.equal(player.state.playing, false);
    player.suspend(false);
    await tick();
    assert.equal(player.state.playing, true);

    player.toggle(); // the player pauses by hand
    player.suspend(true);
    player.suspend(false);
    await tick();
    assert.equal(player.state.playing, false, "it stays paused");
  });

  it("the queue is remembered and comes back paused, with its position", async () => {
    const first = setup();
    first.player.playList(songs(3), 2);
    await tick();
    first.audio.currentTime = 42;
    first.player.tick(0.016);
    first.player.pause();
    const again = setup();
    for (const [key, value] of first.store) again.store.set(key, value);
    const restored = new MusicPlayer({ audio: new FakeAudio(), backend: { source: async () => null, lyrics: async () => again.lyrics, cover: async () => null }, storage: { getItem: (key) => again.store.get(key) ?? null, setItem: () => {} } });
    assert.equal(restored.state.song?.id, 3);
    assert.equal(restored.state.count, 3);
    assert.equal(restored.state.playing, false);
    assert.equal(Math.round(restored.state.positionMs / 1000), 42);
  });

  it("a damaged saved queue is ignored", () => {
    const bad = new MusicPlayer({ audio: new FakeAudio(), backend: { source: async () => null, lyrics: async () => ({ lines: [], timed: false, instrumental: true, hasTranslation: false }), cover: async () => null }, storage: { getItem: () => "{not json", setItem: () => {} } });
    assert.equal(bad.state.count, 0);
  });

  it("the lyric line follows the position and a window of lines is offered for printing", async () => {
    const { audio, player } = setup();
    player.playList(songs(1), 0);
    await tick();
    assert.equal(player.state.lyricIndex, 0);
    audio.currentTime = 12;
    assert.equal(player.tick(0.016), true);
    assert.equal(player.state.lyricIndex, 2);
    assert.equal(player.tick(0.016), false, "no change, no announcement");
    const window = player.lyricWindow(2, 2)!;
    assert.deepEqual(window.lines.map((line) => line.text), ["a", "b", "c", "d", "e"]);
    assert.equal(window.current, 2);
    audio.currentTime = 29;
    player.tick(0.016);
    const end = player.lyricWindow(2, 2)!;
    assert.deepEqual(end.lines.map((line) => line.text), ["b", "c", "d", "e", "f"]);
    assert.equal(end.current, 4);
  });

  it("loudness: the meter's reading is followed; without a meter a soft pulse keeps the scene alive while playing and dies away after", async () => {
    let reading = 0.8;
    const meter: Meter = { level: () => reading, resume() {} };
    const metered = setup({ meter: () => meter });
    metered.player.playList(songs(1), 0);
    await tick();
    for (let i = 0; i < 30; i++) metered.player.tick(0.033);
    assert.ok(metered.player.state.level > 0.7);
    reading = 0;

    const plain = setup();
    plain.player.playList(songs(1), 0);
    await tick();
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      plain.player.tick(0.033);
      peak = Math.max(peak, plain.player.state.level);
    }
    assert.ok(peak > 0.15 && peak <= 1, `peak ${peak}`);
    plain.player.pause();
    for (let i = 0; i < 200; i++) plain.player.tick(0.033);
    assert.equal(plain.player.state.level, 0);
  });

  it("spectrum: a meter that reads bands drives the scene's bands and the level; without one a made-up groove does; paused, it all falls still", async () => {
    let raw: (band: number) => number = (band) => (band < 4 ? 0.9 : 0.02);
    const meter: Meter = { level: () => 0, bands: (out) => out.forEach((_, band) => (out[band] = raw(band))), resume() {} };
    const real = setup({ meter: () => meter });
    real.player.playList(songs(1), 0);
    await tick();
    for (let i = 0; i < 30; i++) real.player.tick(1 / 60);
    assert.ok(real.player.spectrum.at(0) > 0.8, `bass ${real.player.spectrum.at(0)}`);
    assert.equal(real.player.spectrum.at(1), 0, "the treble was silent");
    assert.ok(real.player.state.level > 0.2, "the level follows the spectrum's energy");
    raw = () => 0;
    real.player.pause();
    for (let i = 0; i < 240; i++) real.player.tick(1 / 60);
    assert.equal(real.player.spectrum.active, false);
    assert.equal(real.player.state.level, 0);

    const plain = setup();
    plain.player.playList(songs(1), 0);
    await tick();
    for (let i = 0; i < 120; i++) plain.player.tick(1 / 60);
    assert.ok(plain.player.spectrum.active, "no meter: the made-up groove keeps the archives dancing");
    assert.ok(plain.player.spectrum.energy > 0.05);
    plain.player.pause();
    for (let i = 0; i < 240; i++) plain.player.tick(1 / 60);
    assert.equal(plain.player.spectrum.active, false);
  });

  it("'play next' puts the song behind the current one; on an empty queue it simply plays", async () => {
    const empty = setup();
    empty.player.playNext(song(9));
    await tick();
    assert.equal(empty.player.state.song?.id, 9);
    const { player } = setup();
    player.playList(songs(3), 0);
    await tick();
    player.playNext(song(7));
    assert.deepEqual(player.queue.songs.map((entry) => entry.id), [1, 7, 2, 3]);
    assert.equal(player.state.count, 4);
  });

  it("'play now' on a song that is already queued jumps to it instead of duplicating it", async () => {
    const { player } = setup();
    player.playList(songs(3), 0);
    await tick();
    player.playNow(song(3));
    await tick();
    assert.equal(player.queue.length, 3);
    assert.equal(player.state.song?.id, 3);
    player.playNow(song(8));
    await tick();
    assert.equal(player.state.song?.id, 8);
    assert.equal(player.queue.length, 4);
  });
});

describe("lineIndex", () => {
  it("is the last line that has started", () => {
    const lines = [{ t: 0, text: "" }, { t: 100, text: "" }, { t: 200, text: "" }];
    assert.equal(lineIndex(lines, -5), -1);
    assert.equal(lineIndex(lines, 0), 0);
    assert.equal(lineIndex(lines, 199), 1);
    assert.equal(lineIndex(lines, 1e9), 2);
  });
});
