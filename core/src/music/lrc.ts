import type { LyricLine, MusicLyrics } from "./types";

/**
 * Lyrics in LRC form ("[mm:ss.xx]text"). NetEase adds two quirks: several time stamps in front of one line, and the
 * credit lines of newer songs, which are JSON objects ({"t":0,"c":[{"tx":"作词: "},{"tx":"…"}]}).
 */

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  let offset = 0;
  for (const source of raw.replace(/\r/g, "").split("\n")) {
    const line = source.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const entry = JSON.parse(line) as { t?: unknown; c?: { tx?: unknown }[] };
        const text = (entry.c ?? []).map((part) => (typeof part.tx === "string" ? part.tx : "")).join("").trim();
        if (typeof entry.t === "number" && text) lines.push({ t: Math.max(0, Math.round(entry.t)), text });
      } catch {
        /* not a credit line after all */
      }
      continue;
    }
    const shift = /^\[offset:\s*([+-]?\d+)\]/i.exec(line);
    if (shift) {
      offset = Number(shift[1]);
      continue;
    }
    const stamps = [...line.matchAll(STAMP)];
    if (!stamps.length) continue;
    const text = line.replace(STAMP, "").trim();
    for (const stamp of stamps) {
      const fraction = stamp[3] ? Number(`0.${stamp[3]}`) : 0;
      lines.push({ t: Math.round((Number(stamp[1]) * 60 + Number(stamp[2]) + fraction) * 1000), text });
    }
  }
  if (offset) for (const line of lines) line.t = Math.max(0, line.t - offset);
  return lines.sort((a, b) => a.t - b.t);
}

/** The text split into lines when it has no time stamps at all; every `t` is −1. */
export function plainLines(raw: string): LyricLine[] {
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text && !/^\[[a-z]+:.*\]$/i.test(text))
    .map((text) => ({ t: -1, text }));
}

/** Put the translated line next to the original with the nearest start time (within `tolerance` ms). */
export function mergeTranslation(lines: LyricLine[], translated: LyricLine[], tolerance = 700): LyricLine[] {
  if (!translated.length) return lines;
  const used = new Set<number>();
  return lines.map((line) => {
    let best = -1;
    let bestGap = tolerance + 1;
    translated.forEach((candidate, index) => {
      if (used.has(index) || !candidate.text) return;
      const gap = Math.abs(candidate.t - line.t);
      if (gap < bestGap) {
        best = index;
        bestGap = gap;
      }
    });
    if (best < 0 || !line.text) return line;
    used.add(best);
    return { ...line, trans: translated[best].text };
  });
}

/** Index of the line being sung at `ms`, or −1 before the first line. */
export function lineIndexAt(lines: readonly LyricLine[], ms: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].t <= ms) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

interface RawLyricResponse {
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
  nolyric?: boolean;
  uncollected?: boolean;
}

export function buildLyrics(raw: RawLyricResponse): MusicLyrics {
  const original = raw.lrc?.lyric ?? "";
  if (raw.nolyric || (raw.uncollected && !original)) return { lines: [], timed: false, instrumental: true, hasTranslation: false };
  const timed = parseLrc(original);
  if (!timed.length) {
    const lines = plainLines(original);
    return { lines, timed: false, instrumental: lines.length === 0, hasTranslation: false };
  }
  const translation = parseLrc(raw.tlyric?.lyric ?? "");
  const merged = mergeTranslation(timed, translation);
  return { lines: merged, timed: true, instrumental: false, hasTranslation: merged.some((line) => line.trans) };
}
