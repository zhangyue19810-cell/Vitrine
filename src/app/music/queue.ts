import type { MusicSong } from "../types";

/**
 * The play queue: which song comes next. Pure logic (no audio, no DOM) so it can be tested on its own.
 *
 *  - order:   play the list once and stop at the end
 *  - loop:    play the list again and again
 *  - single:  repeat the song that ends (a manual "next" still moves on)
 *  - shuffle: a random order in which every song comes once before any comes again; "previous" walks back through it
 */

export type PlayMode = "order" | "loop" | "single" | "shuffle";
export const PLAY_MODES: readonly PlayMode[] = ["order", "loop", "single", "shuffle"];

export const MODE_LABEL: Record<PlayMode, string> = { order: "顺序播放", loop: "列表循环", single: "单曲循环", shuffle: "随机播放" };

export function shuffled(count: number, first: number | undefined, random: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (first !== undefined && first >= 0 && first < count) {
    const at = order.indexOf(first);
    [order[0], order[at]] = [order[at], order[0]];
  }
  return order;
}

export class PlayQueue {
  songs: MusicSong[] = [];
  /** Index into `songs` of the current song, −1 when nothing is chosen. */
  index = -1;
  mode: PlayMode;
  /** The order of play for shuffle, as indices into `songs`; `slot` is the current place in it. */
  private order: number[] = [];
  private slot = -1;

  constructor(
    mode: PlayMode = "loop",
    private readonly random: () => number = Math.random,
  ) {
    this.mode = mode;
  }

  get current(): MusicSong | undefined {
    return this.songs[this.index];
  }

  get length(): number {
    return this.songs.length;
  }

  setMode(mode: PlayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "shuffle") this.reshuffle();
  }

  /** Replace the queue and start at `start`. */
  set(songs: MusicSong[], start = 0): void {
    this.songs = songs.slice();
    this.index = songs.length ? Math.min(Math.max(0, start), songs.length - 1) : -1;
    this.reshuffle();
  }

  /** Make the song at `index` the current one (a click on a song of the queue). */
  jump(index: number): MusicSong | undefined {
    if (index < 0 || index >= this.songs.length) return undefined;
    this.index = index;
    if (this.mode === "shuffle") {
      const at = this.order.indexOf(index);
      if (at >= 0) this.slot = at;
      else this.reshuffle();
    }
    return this.current;
  }

  /** "Play next": put the song right behind the current one. On an empty queue it simply becomes the queue. */
  insertNext(song: MusicSong): void {
    if (this.index < 0) {
      this.set([song], 0);
      return;
    }
    if (this.songs[this.index].id === song.id) return;
    const existing = this.songs.findIndex((entry) => entry.id === song.id);
    if (existing >= 0) this.removeAt(existing);
    const at = this.index + 1;
    this.songs.splice(at, 0, song);
    this.order = this.order.map((entry) => (entry >= at ? entry + 1 : entry));
    if (this.mode === "shuffle") this.order.splice(this.slot + 1, 0, at);
  }

  removeAt(index: number): void {
    if (index < 0 || index >= this.songs.length) return;
    this.songs.splice(index, 1);
    if (index < this.index) this.index--;
    else if (index === this.index) this.index = Math.min(this.index, this.songs.length - 1);
    this.reshuffle();
  }

  /** The index to play when the current song ends by itself, or −1 to stop. */
  advance(): number {
    if (!this.songs.length) return -1;
    if (this.mode === "single") return this.index;
    return this.step(1, this.mode !== "order");
  }

  /** The index of the "next" button: it always moves on, wrapping at the end (except in order mode, which stops there). */
  next(): number {
    if (!this.songs.length) return -1;
    return this.step(1, this.mode !== "order");
  }

  prev(): number {
    if (!this.songs.length) return -1;
    return this.step(-1, this.mode !== "order");
  }

  private step(direction: 1 | -1, wrap: boolean): number {
    if (this.mode === "shuffle") {
      let slot = this.slot + direction;
      if (slot >= this.order.length) {
        // A new round, and its first song is never the one that has just been played.
        const last = this.order[this.order.length - 1];
        this.order = shuffled(this.songs.length, undefined, this.random);
        if (this.order.length > 1 && this.order[0] === last) [this.order[0], this.order[1]] = [this.order[1], this.order[0]];
        slot = 0;
      } else if (slot < 0) {
        slot = wrap ? 0 : -1;
        if (slot < 0) return -1;
      }
      this.slot = slot;
      this.index = this.order[slot];
      return this.index;
    }
    let next = this.index + direction;
    if (next >= this.songs.length || next < 0) {
      if (!wrap) return -1;
      next = (next + this.songs.length) % this.songs.length;
    }
    this.index = next;
    return next;
  }

  private reshuffle(): void {
    if (this.mode !== "shuffle") {
      this.order = [];
      this.slot = -1;
      return;
    }
    this.order = shuffled(this.songs.length, this.index >= 0 ? this.index : undefined, this.random);
    this.slot = this.index >= 0 ? 0 : -1;
  }
}
