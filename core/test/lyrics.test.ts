import assert from "node:assert/strict";
import test from "node:test";
import { LyricsFeed } from "../../src/app/music/lyrics-feed";
import type { MusicPlayer } from "../../src/app/music/player";
import { LYRICS, breakRows, stackSlots, sungShare, type LyricLine } from "../../src/space/lyrics3d";

/** A Chinese letter is as wide as it is tall (1 em), a Latin one about half of that. */
const advance = (ch: string) => (/[　-鿿＀-￯]/.test(ch) ? 1 : 0.5);
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const widthOf = (text: string) => Array.from(text).reduce((sum, ch) => sum + advance(ch), 0);

// ───────────────────────────────────────────── breaking a line into rows ─────────────────────────────────────────────

test("a line that fits is one row, and its translation goes under it, smaller and without the music's jump", () => {
  const single = breakRows("玻璃后面有光", undefined, 11, advance);
  assert.equal(single.rows.length, 1);
  assert.equal(single.rows[0].text, "玻璃后面有光");
  assert.equal(single.rows[0].bounce, 1);
  near(single.height, LYRICS.rowHeight);

  const translated = breakRows("玻璃后面有光", "Light behind the glass", 11, advance);
  assert.equal(translated.rows.length, 2);
  assert.equal(translated.rows[1].text, "Light behind the glass");
  assert.equal(translated.rows[1].scale, LYRICS.trans);
  assert.equal(translated.rows[1].bounce, 0, "the translation does not jump");
  near(translated.height, LYRICS.rowHeight * (1 + LYRICS.trans));

  // A title's second row (the artists) is smaller still.
  const title = breakRows("夜航船", "Kaze", 11, advance, true);
  assert.equal(title.rows[1].scale, 0.5);
});

test("a line that is too wide breaks at its punctuation where there is some, loses no letter, and is at most three rows", () => {
  const text = "玻璃后面有光，慢慢移动的是整个夏天的时间，而不是我们";
  const layout = breakRows(text, undefined, 11, advance);
  assert.ok(layout.rows.length >= 2 && layout.rows.length <= 3, `${layout.rows.length} rows`);
  assert.equal(layout.rows.map((row) => row.text).join(""), text, "every letter is somewhere");
  // Every row but the last fits the box (the last one is made smaller to fit it when it does not).
  for (const row of layout.rows.slice(0, -1)) assert.ok(widthOf(row.text) <= 11 + 1e-9, `"${row.text}" is ${widthOf(row.text)} em wide`);
  // The first break is at the comma (which lies well inside the first row) rather than in the middle of a phrase …
  assert.equal(layout.rows[0].text, "玻璃后面有光，");
  // … while with no punctuation in reach, the row is simply filled to the box: 12 letters would be 12 em.
  const plain = breakRows("每一格抽屉都藏着一个夏天，我们把名字写在标签上", undefined, 11, advance);
  assert.equal(plain.rows[0].text, "每一格抽屉都藏着一个夏", "the comma is further than the box reaches");
  assert.equal(widthOf(plain.rows[0].text), 11);
  // However long, never more than three rows of the line itself.
  const long = breakRows("长".repeat(200), undefined, 11, advance);
  assert.equal(long.rows.length, 3);
  assert.equal(long.rows.map((row) => row.text).join(""), "长".repeat(200));
});

test("a line without letters still has a place (a dot), and spaces count as places to break", () => {
  assert.equal(breakRows("   ", undefined, 11, advance).rows[0].text, "·");
  const english = breakRows("Light drifts slowly behind the glass of a quiet archive room", undefined, 11, advance);
  assert.ok(english.rows.length >= 2);
  // No word is cut in two while there is a space to break at.
  for (const row of english.rows.slice(0, -1)) assert.ok(row.text.endsWith(" ") || widthOf(row.text) <= 11, row.text);
  assert.equal(english.rows.map((row) => row.text).join(""), "Light drifts slowly behind the glass of a quiet archive room");
});

// ───────────────────────────────────────────── the window of lines ─────────────────────────────────────────────

test("the line being sung is in the middle, the ones after it pile up below and the ones before it above, each fainter and further out of focus", () => {
  const slots = stackSlots(10, () => LYRICS.rowHeight);
  assert.equal(slots.size, 1 + LYRICS.before + LYRICS.after);
  const middle = slots.get(10);
  assert.ok(middle);
  assert.deepEqual({ ...middle }, { y: 0, scale: 1, alpha: 1, blur: 0, tilt: 0 });
  let last = middle;
  for (let d = 1; d <= LYRICS.after; d++) {
    const slot = slots.get(10 + d);
    assert.ok(slot, `line +${d}`);
    assert.ok(slot.y < last.y, `line +${d} is lower than the one before it`);
    assert.ok(slot.alpha < last.alpha, `and fainter`);
    assert.ok(slot.scale < last.scale || d === 1 || slot.scale <= last.scale, `and no larger`);
    assert.ok(slot.blur >= last.blur, `and no sharper`);
    assert.ok(slot.tilt > 0, "the lines after it lean away at the bottom");
    last = slot;
  }
  last = middle;
  for (let d = 1; d <= LYRICS.before; d++) {
    const slot = slots.get(10 - d);
    assert.ok(slot, `line −${d}`);
    assert.ok(slot.y > last.y, `line −${d} is higher than the one after it`);
    assert.ok(slot.alpha < last.alpha);
    assert.ok(slot.blur >= last.blur);
    assert.ok(slot.tilt < 0, "the lines before it lean away at the top");
    last = slot;
  }
  assert.ok(!slots.has(10 + LYRICS.after + 1) && !slots.has(10 - LYRICS.before - 1), "nothing beyond the window");
});

test("the lines never overlap, however tall each one is, and a taller line pushes its neighbours further away", () => {
  const heights = new Map<number, number>([
    [4, LYRICS.rowHeight * (1 + LYRICS.trans)],
    [5, LYRICS.rowHeight * 3],
    [6, LYRICS.rowHeight * (1 + LYRICS.trans)],
    [7, LYRICS.rowHeight * 2],
  ]);
  const heightOf = (index: number) => heights.get(index) ?? LYRICS.rowHeight;
  const slots = stackSlots(5, heightOf);
  const extent = (index: number) => {
    const slot = slots.get(index)!;
    const half = (heightOf(index) * slot.scale) / 2;
    return { top: slot.y + half, bottom: slot.y - half };
  };
  for (let index = 3; index < 8; index++) {
    const upper = extent(index);
    const lower = extent(index + 1);
    assert.ok(upper.bottom > lower.top, `lines ${index} and ${index + 1} are apart (${upper.bottom} > ${lower.top})`);
  }
  // The gap under the sung line is `gap` times the next line's scale.
  near(extent(5).bottom - extent(6).top, LYRICS.gap * slots.get(6)!.scale);
  // The same with short lines puts the next line closer.
  const short = stackSlots(5, () => LYRICS.rowHeight);
  assert.ok(slots.get(6)!.y < short.get(6)!.y, "the taller line pushes the next one lower");
  assert.ok(slots.get(4)!.y > short.get(4)!.y, "and the one before it higher");
});

test("the window is rebuilt in the map it is given (nothing is allocated every frame)", () => {
  const goal = new Map();
  const first = stackSlots(0, () => 1, goal);
  assert.equal(first, goal);
  const second = stackSlots(7, () => 1, goal);
  assert.equal(second, goal);
  assert.ok(second.has(7) && !second.has(0), "the old window is gone");
});

// ───────────────────────────────────────────── the gold that follows the singer ─────────────────────────────────────────────

const LINES: LyricLine[] = [
  { t: 1000, text: "a" },
  { t: 5000, text: "b" },
  { t: 65_000, text: "c" },
  { t: 65_300, text: "d" },
];

test("lines already sung are all gold, the ones to come have none, and the current one fills as the singer goes through it", () => {
  assert.equal(sungShare(LINES, 0, 1, 7000), 1.2, "a line before the current one");
  assert.equal(sungShare(LINES, 2, 1, 7000), 0, "a line after it");
  assert.equal(sungShare(null, 0, 0, 7000), 1.2, "the title is all sung");
  // The singer is done at 82% of the way to the next line: 1 s + 3.28 s.
  near(sungShare(LINES, 0, 0, 1000), 0);
  near(sungShare(LINES, 0, 0, 1000 + 3280 / 2), 0.5);
  near(sungShare(LINES, 0, 0, 1000 + 3280), 1);
  assert.equal(sungShare(LINES, 0, 0, 4500), sungShare(LINES, 0, 0, 4500), "the same position, the same answer");
  // Before the line starts nothing is gold; long after, no more than 1.2 (a little more than all of it).
  assert.equal(sungShare(LINES, 0, 0, 200), 0);
  assert.equal(sungShare(LINES, 0, 0, 99_999), 1.2);
  // It only ever goes forward as the position does.
  let before = -1;
  for (let ms = 0; ms < 8000; ms += 100) {
    const now = sungShare(LINES, 0, 0, ms);
    assert.ok(now >= before, `at ${ms} ms`);
    before = now;
  }
});

test("no line takes longer than eight seconds to sing, or less than 0.6 s, and the last line is given five", () => {
  // Line c is followed by a gap of 300 ms: it still takes 0.6 s.
  near(sungShare(LINES, 2, 2, 65_000 + 300), 0.5);
  // The gap before c is a minute: the line before it (b, at 5 s) is sung in eight seconds, not in a minute.
  near(sungShare(LINES, 1, 1, 5000 + 4000), 0.5);
  // The last line: 5 s × 0.82.
  near(sungShare(LINES, 3, 3, 65_300 + 2050), 0.5);
  // A line without a time stamp is not sung (nor is one before the song).
  assert.equal(sungShare([{ t: -1, text: "x" }], 0, 0, 5000), 0);
});

// ───────────────────────────────────────────── what the page tells the lyrics ─────────────────────────────────────────────

interface FakeState {
  song?: { id: number; name: string; artists: string[]; durationMs: number };
  positionMs: number;
  durationMs: number;
  lyrics?: { lines: LyricLine[]; timed: boolean; instrumental: boolean; hasTranslation: boolean };
  lyricIndex: number;
}

const fake = (state: FakeState) => ({ state }) as unknown as MusicPlayer;
const song = (id: number) => ({ id, name: `歌 ${id}`, artists: ["甲", "乙"], durationMs: 100_000 });

test("without a song the lyrics have nothing to show; with a song but no lyrics they show its title and artists", () => {
  const state: FakeState = { positionMs: 0, durationMs: 0, lyricIndex: -1 };
  const feed = new LyricsFeed(fake(state));
  assert.equal(feed.read(), null);
  state.song = song(1);
  const shown = feed.read();
  assert.ok(shown);
  assert.equal(shown.lines, null);
  assert.equal(shown.title, "歌 1");
  assert.equal(shown.subtitle, "甲 / 乙");
  // An instrumental says so.
  state.lyrics = { lines: [], timed: false, instrumental: true, hasTranslation: false };
  const instrumental = feed.read()!;
  assert.equal(instrumental.lines, null);
  assert.equal(instrumental.subtitle, "甲 / 乙  ·  纯音乐");
  // Lyrics that are empty are the same as none.
  state.lyrics = { lines: [], timed: true, instrumental: false, hasTranslation: false };
  assert.equal(feed.read()!.lines, null);
});

test("timed lyrics are passed on as they are, with the player's own line; the same object comes back every frame", () => {
  const lines: LyricLine[] = [
    { t: 0, text: "一" },
    { t: 4000, text: "二" },
    { t: 8000, text: "三" },
  ];
  const state: FakeState = { song: song(5), positionMs: 4200, durationMs: 100_000, lyrics: { lines, timed: true, instrumental: false, hasTranslation: false }, lyricIndex: 1 };
  const feed = new LyricsFeed(fake(state));
  const first = feed.read()!;
  assert.equal(first.lines, lines, "the very array of the player");
  assert.equal(first.index, 1);
  assert.equal(first.positionMs, 4200);
  const id = first.id;
  state.positionMs = 8100;
  state.lyricIndex = 2;
  const second = feed.read()!;
  assert.equal(second, first, "one object, reused");
  assert.equal(second.index, 2);
  assert.equal(second.id, id, "the same song keeps its id (the lines are not laid out again)");
  // Another song: a new id.
  state.song = song(6);
  assert.notEqual(feed.read()!.id, id);
  // And coming back to the first one is another new id again (the layer starts afresh).
  const other = feed.read()!.id;
  state.song = song(5);
  assert.notEqual(feed.read()!.id, other);
});

test("lyrics without time stamps are spread evenly over the song so that they still move on with the music", () => {
  const lines: LyricLine[] = ["一", "二", "三", "四"].map((text) => ({ t: -1, text }));
  const state: FakeState = { song: song(9), positionMs: 0, durationMs: 80_000, lyrics: { lines, timed: false, instrumental: false, hasTranslation: false }, lyricIndex: -1 };
  const feed = new LyricsFeed(fake(state));
  const first = feed.read()!;
  assert.ok(first.lines);
  assert.deepEqual(first.lines!.map((line) => line.t), [0, 20_000, 40_000, 60_000]);
  assert.deepEqual(first.lines!.map((line) => line.text), ["一", "二", "三", "四"]);
  assert.equal(first.index, 0);
  const spread = first.lines;
  const at = (ms: number) => {
    state.positionMs = ms;
    return feed.read()!.index;
  };
  assert.equal(at(19_999), 0);
  assert.equal(at(20_000), 1);
  assert.equal(at(61_000), 3);
  assert.equal(at(80_000), 3, "at the very end the last line stays");
  assert.equal(at(-5), -1, "before the song: before the first line (the layer shows the first one all the same)");
  // The player's idea of the length sharpens as the audio loads: a second more or less does not lay the lines out again …
  state.durationMs = 81_000;
  assert.equal(feed.read()!.lines, spread);
  // … but a real change does (a preview that turns out to be the whole song).
  state.durationMs = 120_000;
  const stretched = feed.read()!;
  assert.notEqual(stretched.lines, spread);
  assert.deepEqual(stretched.lines!.map((line) => line.t), [0, 30_000, 60_000, 90_000]);
  // Before the length is known, the song's own is used; with neither, they are not shown (the title is).
  state.durationMs = 0;
  assert.ok(feed.read()!.lines, "the song's duration is the fallback");
  state.song = { ...song(9), durationMs: 0 };
  assert.equal(feed.read()!.lines, null);
});
