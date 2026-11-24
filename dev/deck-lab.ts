import "../src/styles/base.css";
import { DeckScene, type DeckState } from "../src/deck/deck-scene";
import { lineAt } from "../src/deck/model";
import { Spectrum } from "../src/spectrum";

/**
 * A design lab for the now-playing deck: the scene alone, with a made-up song, made-up lyrics and the spectrum's synthetic
 * groove, so that the look can be worked on (and photographed) without the launcher around it. Open it in the dev server:
 * `/dev/deck-lab.html` — `?dark=1` for the night theme, `?paused=1`, `?empty=1` (nothing queued), `?t=60` (start at second 60).
 * The page exposes `window.__lab` with `step(frames, dt)` for scripted runs.
 */

const params = new URLSearchParams(location.search);
const container = document.querySelector<HTMLElement>("#lab")!;
const deck = new DeckScene(container);
const spectrum = new Spectrum();

function cover(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const sky = ctx.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, "#1b2a6b");
  sky.addColorStop(0.55, "#d9487a");
  sky.addColorStop(1, "#ffb86b");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = "#ffe9b0";
  ctx.beginPath();
  ctx.arc(330, 330, 90, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#101533";
  ctx.beginPath();
  ctx.moveTo(0, 512);
  ctx.lineTo(0, 400);
  ctx.lineTo(120, 340);
  ctx.lineTo(220, 410);
  ctx.lineTo(340, 330);
  ctx.lineTo(512, 420);
  ctx.lineTo(512, 512);
  ctx.fill();
  return canvas;
}

const lyricsText = [
  ["夜航星", "Night Voyage Star"],
  ["作词：测试 作曲：测试", ""],
  ["在无人的海面上", "On the empty sea"],
  ["有一颗星亮着微光", "A star shines faintly"],
  ["我顺着它的方向", "I follow its direction"],
  ["把船开向没有尽头的远方", "Sailing toward the endless distance"],
  ["风把云吹成了你的模样", "The wind shapes the clouds like you"],
  ["我在甲板上轻轻地唱", "I sing softly on the deck"],
  ["每一个浪都是一页信纸", "Every wave is a sheet of letter"],
  ["写着我没能说出口的话", "Words I could not say"],
  ["如果黎明迟迟不来", "If the dawn never comes"],
  ["就让这首歌替我点灯", "Let this song light the lamp for me"],
  ["你听见了吗", "Can you hear it"],
  ["这是我寄给远方的回声", "This is the echo I send afar"],
];
const lines = lyricsText.map(([text, trans], i) => ({ t: 1000 + i * 4200, text, trans: params.has("trans") || params.get("trans") !== "0" ? trans : undefined }));

const startAt = Number(params.get("t") ?? 0) * 1000;
const empty = params.has("empty");
const paused = params.has("paused");
const dark = params.has("dark");
const image = cover();

const state: DeckState = {
  open: true,
  song: empty ? null : { title: "夜航星（Night Voyage）", artists: "不才 / 测试歌手", album: "夜航 · 原声带" },
  status: paused ? "已暂停" : "正在播放",
  cover: empty ? null : image,
  coverId: 1,
  playing: !empty && !paused,
  loading: false,
  progress: 0,
  positionMs: startAt,
  durationMs: 61000 + 4200 * 12,
  lyrics: empty ? null : { lines, timed: true },
  lyricsId: 1,
  lyricIndex: -1,
  lyricsNote: empty ? "在「曲库」里选一张档案开始播放" : "",
  spectrum: spectrum,
  dark,
};
deck.setSource({ read: () => state });
document.documentElement.style.background = dark ? "#0f1619" : "#eae5e1";

let last = performance.now();
let simulated = 0;

function advance(dt: number) {
  simulated += dt;
  if (state.playing) {
    state.positionMs = (state.positionMs + dt * 1000) % state.durationMs;
    spectrum.synth(dt);
  } else spectrum.release(dt);
  state.progress = state.positionMs / state.durationMs;
  state.lyricIndex = lineAt(lines, state.positionMs);
  deck.update(dt, simulated);
}

function frame(now: number) {
  advance(Math.min(0.05, (now - last) / 1000));
  last = now;
  requestAnimationFrame(frame);
}

if (!params.has("manual")) requestAnimationFrame(frame);

(window as unknown as Record<string, unknown>).__lab = {
  deck,
  state,
  spectrum,
  step(frames: number, dt = 1 / 30) {
    for (let i = 0; i < frames; i++) advance(dt);
  },
};
window.addEventListener("resize", () => deck.resize());
document.fonts?.load("32px \"LXGW WenKai\"", "夜航星歌词测试").then(() => deck.repaintAll());
