import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlayQueue, shuffled } from "../../src/app/music/queue";
import type { MusicSong } from "../../src/app/types";

const song = (id: number): MusicSong => ({ id, name: `s${id}`, artists: [], album: "", cover: "", durationMs: 1000, fee: 0, unavailable: false });
const songs = (count: number) => Array.from({ length: count }, (_, i) => song(i + 1));
/** A small deterministic random source. */
const lcg = (seed = 7) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe("play queue", () => {
  it("order mode plays the list once: the end stops, and so does 'previous' at the start", () => {
    const queue = new PlayQueue("order");
    queue.set(songs(3), 0);
    assert.equal(queue.advance(), 1);
    assert.equal(queue.advance(), 2);
    assert.equal(queue.advance(), -1);
    assert.equal(queue.index, 2, "stays on the last song");
    assert.equal(queue.next(), -1);
    queue.jump(0);
    assert.equal(queue.prev(), -1);
  });

  it("loop mode wraps in both directions", () => {
    const queue = new PlayQueue("loop");
    queue.set(songs(3), 2);
    assert.equal(queue.advance(), 0);
    assert.equal(queue.prev(), 2);
    assert.equal(queue.next(), 0);
  });

  it("single mode repeats when a song ends but 'next' still moves on", () => {
    const queue = new PlayQueue("single");
    queue.set(songs(3), 1);
    assert.equal(queue.advance(), 1);
    assert.equal(queue.advance(), 1);
    assert.equal(queue.next(), 2);
    assert.equal(queue.prev(), 1);
  });

  it("shuffle plays every song once per round, begins with the chosen one, and never repeats at a round's edge", () => {
    const queue = new PlayQueue("shuffle", lcg());
    queue.set(songs(6), 3);
    const first = [queue.index];
    for (let i = 0; i < 5; i++) first.push(queue.advance());
    assert.equal(first[0], 3);
    assert.deepEqual([...first].sort(), [0, 1, 2, 3, 4, 5]);
    const second = [];
    for (let i = 0; i < 6; i++) second.push(queue.advance());
    assert.notEqual(second[0], first[5], "the new round does not start with the song that ended the last one");
    assert.deepEqual([...second].sort(), [0, 1, 2, 3, 4, 5]);
  });

  it("'previous' in shuffle walks back through what was played", () => {
    const queue = new PlayQueue("shuffle", lcg(3));
    queue.set(songs(5), 0);
    const played = [queue.index, queue.advance(), queue.advance(), queue.advance()];
    assert.equal(queue.prev(), played[2]);
    assert.equal(queue.prev(), played[1]);
    assert.equal(queue.prev(), played[0]);
    assert.equal(queue.prev(), played[0], "at the beginning of the round it stays");
  });

  it("'play next' puts a song right behind the current one and moves a duplicate instead of adding it twice", () => {
    const queue = new PlayQueue("loop");
    queue.set(songs(4), 1);
    queue.insertNext(song(99));
    assert.deepEqual(queue.songs.map((entry) => entry.id), [1, 2, 99, 3, 4]);
    queue.insertNext(song(4));
    assert.deepEqual(queue.songs.map((entry) => entry.id), [1, 2, 4, 99, 3]);
    queue.insertNext(song(2));
    assert.equal(queue.songs.length, 5, "the current song is not added again");
    assert.equal(queue.current?.id, 2);
  });

  it("in shuffle, 'play next' is really what plays next", () => {
    const queue = new PlayQueue("shuffle", lcg(11));
    queue.set(songs(8), 2);
    queue.advance();
    queue.insertNext(song(77));
    assert.equal(queue.songs[queue.advance()].id, 77);
  });

  it("an empty queue answers −1 everywhere and 'play next' on it makes the song the queue", () => {
    const queue = new PlayQueue("loop");
    assert.deepEqual([queue.advance(), queue.next(), queue.prev()], [-1, -1, -1]);
    queue.insertNext(song(5));
    assert.equal(queue.current?.id, 5);
    assert.equal(queue.length, 1);
  });

  it("removing a song keeps the current song current", () => {
    const queue = new PlayQueue("loop");
    queue.set(songs(5), 3);
    queue.removeAt(0);
    assert.equal(queue.current?.id, 4);
    queue.removeAt(queue.index);
    assert.equal(queue.current?.id, 5);
  });

  it("switching to shuffle starts a round with the current song, switching back drops the order", () => {
    const queue = new PlayQueue("loop", lcg(5));
    queue.set(songs(5), 2);
    queue.setMode("shuffle");
    const seen = new Set([queue.index]);
    for (let i = 0; i < 4; i++) seen.add(queue.advance());
    assert.equal(seen.size, 5);
    queue.setMode("loop");
    const at = queue.index;
    assert.equal(queue.advance(), (at + 1) % 5);
  });

  it("jumping to a song inside a shuffled round continues from there", () => {
    const queue = new PlayQueue("shuffle", lcg(9));
    queue.set(songs(6), 0);
    queue.jump(4);
    assert.equal(queue.index, 4);
    const rest = new Set<number>();
    for (let i = 0; i < 5; i++) rest.add(queue.advance());
    assert.ok(rest.size >= 3);
  });

  it("shuffled() is a permutation with the first element in front", () => {
    const order = shuffled(10, 6, lcg(1));
    assert.equal(order[0], 6);
    assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
