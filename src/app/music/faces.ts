import type { FacePainter, FaceState, FaceVariant, Hotspot, StageItem } from "../../archive-stage";
import { DARK, FONT, INFO, LIGHT, button, fit, panel, pill, roundRect, wrap, type Palette } from "../faces";

/**
 * What is printed on the music page's archives: a song, a playlist, and the card that logs in to NetEase Cloud Music (it
 * carries the QR code). Same three faces as every archive — the small one on the card, the "info" face while the pointer rests
 * on it, and the large one of the archive that is pulled out to be read (which also holds the clickable buttons and, for the
 * song that plays, the lyrics). Pure drawing: the payload holds everything that is printed.
 */

export interface SongPayload {
  kind: "song";
  title: string;
  artists: string;
  album: string;
  /** "03:42". */
  duration: string;
  /** Place in the list, from 1. */
  number: number;
  /** Decoded cover when it has arrived (undefined: not yet, null: none available). */
  cover?: CanvasImageSource | null;
  /** "会员" / "无版权" / "". */
  badge: string;
  /** This is the song the player is on. */
  playing: boolean;
  paused: boolean;
  /** The lines around the one being sung (only for the song that plays). */
  lyrics?: { before: string[]; line: string; trans: string; after: string[]; timed: boolean; instrumental: boolean } | null;
  /** What the player has to say about it ("仅试听片段", an error…). */
  note: string;
}

export interface PlaylistPayload {
  kind: "playlist";
  title: string;
  creator: string;
  count: string;
  plays: string;
  description: string;
  note: string;
  cover?: CanvasImageSource | null;
}

export interface LoginPayload {
  kind: "login";
  state: "idle" | "loading" | "waiting" | "scanned" | "expired" | "done" | "error";
  /** The QR code's modules (true: dark), or null when there is none. */
  qr: boolean[][] | null;
  message: string;
  nickname: string;
  avatar?: CanvasImageSource | null;
}

export type MusicPayload = SongPayload | PlaylistPayload | LoginPayload;

export const isMusicPayload = (payload: unknown): payload is MusicPayload => {
  const kind = (payload as { kind?: string } | null)?.kind;
  return kind === "song" || kind === "playlist" || kind === "login";
};

// ──────────────────────────────── small pieces ────────────────────────────────

/** A cover (or, until it has arrived, a tile with a note), clipped to a rounded square. */
function cover(ctx: CanvasRenderingContext2D, image: CanvasImageSource | null | undefined, x: number, y: number, size: number, palette: Palette, glyph = "♪") {
  ctx.save();
  roundRect(ctx, x, y, size, size, size * 0.1);
  ctx.clip();
  ctx.fillStyle = palette.tile;
  ctx.fillRect(x, y, size, size);
  if (image) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, x, y, size, size);
  } else {
    ctx.fillStyle = palette.accentInk;
    ctx.font = `bold ${size * 0.48}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, x + size / 2, y + size / 2 + size * 0.03);
  }
  ctx.restore();
  ctx.strokeStyle = palette.rule;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(1, size / 80);
  roundRect(ctx, x, y, size, size, size * 0.1);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** A QR code with its quiet zone, `size` px square, black on white whatever the theme (scanners need the contrast). */
function qrCode(ctx: CanvasRenderingContext2D, modules: boolean[][], x: number, y: number, size: number) {
  const count = modules.length;
  const quiet = 3;
  const cell = size / (count + quiet * 2);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, size, size, 10);
  ctx.fill();
  ctx.fillStyle = "#101312";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (modules[row][col]) ctx.fillRect(Math.round(x + (col + quiet) * cell), Math.round(y + (row + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }
}

/** Three small bars: this song is playing (still when paused). */
function bars(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, color: string, paused: boolean) {
  ctx.fillStyle = color;
  const heights = paused ? [0.45, 0.45, 0.45] : [0.9, 0.55, 0.75];
  heights.forEach((amount, i) => ctx.fillRect(x + i * (h * 0.28), y + h - h * amount, h * 0.18, h * amount));
}

const STATE_TEXT: Record<LoginPayload["state"], string> = {
  idle: "点击这张档案，获取登录二维码",
  loading: "正在获取二维码…",
  waiting: "用网易云音乐 App 扫描二维码",
  scanned: "已扫码，请在手机上点“确认登录”",
  expired: "二维码已过期，点击刷新",
  done: "已登录",
  error: "出错了，点击重试",
};

// ──────────────────────────────── small faces (512 × 370) ────────────────────────────────

function drawSongCard(ctx: CanvasRenderingContext2D, payload: SongPayload, palette: Palette) {
  panel(ctx, 512, 370, palette.paper, palette.rule);
  cover(ctx, payload.cover, 28, 38, 142, palette);
  ctx.fillStyle = palette.muted;
  ctx.font = `13px ${FONT}`;
  ctx.fillText("歌曲 · 网易云音乐", 192, 54);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 30px ${FONT}`;
  const lines = wrap(ctx, payload.title, 290, 3);
  lines.forEach((line, i) => ctx.fillText(line, 192, 90 + i * 34));
  ctx.fillStyle = palette.muted;
  ctx.font = `17px ${FONT}`;
  ctx.fillText(fit(ctx, payload.artists, 290, 17, 12, "normal"), 192, Math.min(90 + lines.length * 34 + 6, 190));

  ctx.fillStyle = palette.rule;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(28, 206, 456, 1.5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.muted;
  ctx.font = `16px ${FONT}`;
  ctx.fillText(fit(ctx, payload.album || "—", 456, 16, 12, "normal"), 28, 238);

  ctx.fillStyle = palette.ink;
  ctx.font = `bold 66px ${FONT}`;
  ctx.fillText(String(payload.number).padStart(2, "0"), 26, 318);
  let x = 164;
  if (payload.playing) {
    bars(ctx, x, 282, 30, palette.accent, payload.paused);
    x += 40;
    ctx.fillStyle = palette.accentInk;
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillText(payload.paused ? "已暂停" : "正在播放", x, 312);
  } else if (payload.badge) {
    pill(ctx, payload.badge, x, 288, 14, palette.chip, palette.chipInk, "bold");
  }
  ctx.fillStyle = palette.accentInk;
  ctx.font = `bold 24px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(payload.duration, 484, 316);
  ctx.textAlign = "left";
}

function drawPlaylistCard(ctx: CanvasRenderingContext2D, payload: PlaylistPayload, palette: Palette) {
  panel(ctx, 512, 370, palette.paper, palette.rule);
  cover(ctx, payload.cover, 28, 38, 142, palette, "♫");
  ctx.fillStyle = palette.muted;
  ctx.font = `13px ${FONT}`;
  ctx.fillText("歌单 · 网易云音乐", 192, 54);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 30px ${FONT}`;
  const lines = wrap(ctx, payload.title, 290, 3);
  lines.forEach((line, i) => ctx.fillText(line, 192, 90 + i * 34));
  ctx.fillStyle = palette.muted;
  ctx.font = `17px ${FONT}`;
  if (payload.creator) ctx.fillText(fit(ctx, `by ${payload.creator}`, 290, 17, 12, "normal"), 192, Math.min(90 + lines.length * 34 + 6, 190));

  ctx.fillStyle = palette.rule;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(28, 206, 456, 1.5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ink;
  ctx.font = `17px ${FONT}`;
  wrap(ctx, payload.note || payload.description || "", 456, 2).forEach((line, i) => ctx.fillText(line, 28, 238 + i * 25));
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(payload.count, 26, 322);
  ctx.fillStyle = palette.accentInk;
  ctx.font = `bold 22px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(`▶ ${payload.plays}`, 484, 322);
  ctx.textAlign = "left";
}

function drawLoginCard(ctx: CanvasRenderingContext2D, payload: LoginPayload, palette: Palette) {
  panel(ctx, 512, 370, palette.paper, palette.rule);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 21px ${FONT}`;
  ctx.fillText("NETEASE", 26, 58);
  ctx.fillStyle = palette.muted;
  ctx.font = `14px ${FONT}`;
  ctx.fillText("网易云音乐 · 登录", 126, 58);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(payload.state === "done" ? payload.nickname || "已登录" : "扫码登录", 26, 128);
  ctx.fillStyle = palette.muted;
  ctx.font = `17px ${FONT}`;
  wrap(ctx, payload.message || STATE_TEXT[payload.state], payload.qr ? 250 : 440, 4).forEach((line, i) => ctx.fillText(line, 28, 170 + i * 26));
  if (payload.qr) qrCode(ctx, payload.qr, 300, 90, 190);
  ctx.fillStyle = palette.accentInk;
  ctx.font = `bold 16px ${FONT}`;
  ctx.fillText(payload.state === "done" ? "点击查看 · 可退出登录" : "点击放大 · 扫码后自动登录", 26, 340);
}

// ──────────────────────────────── hover face (512 × 370) ────────────────────────────────

function drawInfo(ctx: CanvasRenderingContext2D, payload: MusicPayload) {
  panel(ctx, 512, 370, INFO.paper);
  ctx.fillStyle = INFO.accent;
  ctx.fillRect(26, 22, 56, 4);
  ctx.fillStyle = INFO.ink;
  ctx.font = `bold 26px ${FONT}`;
  const title = payload.kind === "login" ? "网易云音乐" : payload.title;
  const lines = wrap(ctx, title, 460, 2);
  lines.forEach((line, i) => ctx.fillText(line, 26, 64 + i * 32));
  const y = 64 + lines.length * 32 + 12;
  ctx.fillStyle = INFO.muted;
  ctx.font = `17px ${FONT}`;
  if (payload.kind === "song") {
    ctx.fillText(fit(ctx, payload.artists, 460, 17, 12, "normal"), 26, y + 4);
    ctx.fillText(fit(ctx, payload.album || "—", 460, 17, 12, "normal"), 26, y + 34);
    ctx.fillStyle = INFO.ink;
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillText([`时长 ${payload.duration}`, payload.badge].filter(Boolean).join("   ·   "), 26, 322);
    ctx.fillStyle = INFO.accent;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText(payload.playing ? "点击暂停 / 继续" : "点击选中 · 再点一次播放", 26, 346);
  } else if (payload.kind === "playlist") {
    wrap(ctx, payload.description || payload.note || "", 460, 5).forEach((line, i) => ctx.fillText(line, 26, y + i * 25));
    ctx.fillStyle = INFO.ink;
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillText([`${payload.count} 首`, payload.creator ? `by ${payload.creator}` : ""].filter(Boolean).join("   ·   "), 26, 322);
    ctx.fillStyle = INFO.accent;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText("点击选中 · 再点一次打开歌单", 26, 346);
  } else {
    wrap(ctx, payload.message || STATE_TEXT[payload.state], 460, 4).forEach((line, i) => ctx.fillText(line, 26, y + i * 26));
    ctx.fillStyle = INFO.accent;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText("点击选中 · 再点一次放大", 26, 346);
  }
}

// ──────────────────────────────── detail faces (1024 × 741) ────────────────────────────────

function drawSongDetail(ctx: CanvasRenderingContext2D, payload: SongPayload, palette: Palette, hot: string | null): Hotspot[] {
  panel(ctx, 1024, 741, palette.paper, palette.rule);
  const spots: Hotspot[] = [];
  cover(ctx, payload.cover, 52, 62, 188, palette);
  ctx.fillStyle = palette.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText(`歌曲 · 网易云音乐 · 第 ${payload.number} 首`, 268, 84);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 52px ${FONT}`;
  const lines = wrap(ctx, payload.title, 700, 2);
  lines.forEach((line, i) => ctx.fillText(line, 268, 146 + i * 58));
  const y = 146 + (lines.length - 1) * 58 + 44;
  ctx.fillStyle = palette.muted;
  ctx.font = `26px ${FONT}`;
  ctx.fillText(fit(ctx, payload.artists, 700, 26, 18, "normal"), 268, y);
  let x = 268;
  if (payload.album) x += pill(ctx, payload.album.length > 18 ? `${payload.album.slice(0, 17)}…` : payload.album, x, y + 18, 19, palette.chip, palette.chipInk) + 10;
  x += pill(ctx, payload.duration, x, y + 18, 19, palette.chip, palette.chipInk) + 10;
  if (payload.badge) pill(ctx, payload.badge, x, y + 18, 19, palette.accent, "#ffffff", "bold");

  const ruleY = Math.max(282, y + 18 + 32 + 26);
  ctx.fillStyle = palette.rule;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(52, ruleY, 920, 2);
  ctx.globalAlpha = 1;

  // The lyrics: the line being sung in the middle, large; two before and after it, quiet.
  const centre = (ruleY + 636) / 2 + 6;
  ctx.textAlign = "center";
  if (payload.playing && payload.lyrics) {
    const lyrics = payload.lyrics;
    if (lyrics.instrumental) {
      ctx.fillStyle = palette.muted;
      ctx.font = `28px ${FONT}`;
      ctx.fillText("纯音乐，请欣赏", 512, centre);
    } else {
      ctx.fillStyle = palette.muted;
      ctx.font = `24px ${FONT}`;
      lyrics.before.slice(-2).forEach((line, i, all) => ctx.fillText(fit(ctx, line, 880, 24, 16, "normal"), 512, centre - 74 - (all.length - 1 - i) * 38));
      ctx.fillStyle = palette.accentInk;
      ctx.fillText(fit(ctx, lyrics.line || "♪", 880, 40, 22, "bold"), 512, centre - 6);
      if (lyrics.trans) {
        ctx.fillStyle = palette.ink;
        ctx.globalAlpha = 0.75;
        ctx.fillText(fit(ctx, lyrics.trans, 880, 24, 16, "normal"), 512, centre + 36);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = palette.muted;
      lyrics.after.slice(0, 2).forEach((line, i) => ctx.fillText(fit(ctx, line, 880, 24, 16, "normal"), 512, centre + (lyrics.trans ? 78 : 50) + i * 38));
      if (!lyrics.timed) {
        ctx.font = `18px ${FONT}`;
        ctx.fillText("这首歌的歌词没有时间轴，不能滚动", 512, 610);
      }
    }
  } else {
    ctx.fillStyle = palette.muted;
    ctx.font = `28px ${FONT}`;
    ctx.fillText(payload.playing ? "正在载入歌词…" : "播放后在这里显示歌词", 512, centre);
    if (payload.note) {
      ctx.fillStyle = palette.accentInk;
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText(payload.note, 512, centre + 52);
    }
  }
  ctx.textAlign = "left";

  button(ctx, "play", payload.playing ? (payload.paused ? "继续播放" : "暂停") : "播放", 52, 636, 250, 68, true, hot === "play", palette, spots);
  button(ctx, "next", "下一首播放", 322, 636, 240, 68, false, hot === "next", palette, spots);
  return spots;
}

function drawPlaylistDetail(ctx: CanvasRenderingContext2D, payload: PlaylistPayload, palette: Palette, hot: string | null): Hotspot[] {
  panel(ctx, 1024, 741, palette.paper, palette.rule);
  const spots: Hotspot[] = [];
  cover(ctx, payload.cover, 52, 62, 188, palette, "♫");
  ctx.fillStyle = palette.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText("歌单 · 网易云音乐", 268, 84);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 52px ${FONT}`;
  const lines = wrap(ctx, payload.title, 700, 2);
  lines.forEach((line, i) => ctx.fillText(line, 268, 146 + i * 58));
  const y = 146 + (lines.length - 1) * 58 + 44;
  ctx.fillStyle = palette.muted;
  ctx.font = `26px ${FONT}`;
  if (payload.creator) ctx.fillText(fit(ctx, `by ${payload.creator}`, 700, 26, 18, "normal"), 268, y);
  const ruleY = Math.max(282, y + 18 + 26);
  ctx.fillStyle = palette.rule;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(52, ruleY, 920, 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ink;
  ctx.font = `27px ${FONT}`;
  wrap(ctx, payload.description || payload.note || "这个歌单没有简介。", 920, 5).forEach((line, i) => ctx.fillText(line, 52, ruleY + 54 + i * 40));
  const stats: [string, string][] = [["歌曲", `${payload.count} 首`], ["播放", payload.plays], ["编辑", payload.note || "—"]];
  stats.forEach(([label, value], i) => {
    const left = 52 + i * 310;
    ctx.fillStyle = palette.muted;
    ctx.font = `20px ${FONT}`;
    ctx.fillText(label, left, 566);
    ctx.fillStyle = palette.ink;
    ctx.font = `bold 32px ${FONT}`;
    ctx.fillText(fit(ctx, value, 280, 32, 20, "bold"), left, 604);
  });
  button(ctx, "open", "打开歌单", 52, 636, 250, 68, true, hot === "open", palette, spots);
  button(ctx, "playAll", "播放全部", 322, 636, 240, 68, false, hot === "playAll", palette, spots);
  return spots;
}

function drawLoginDetail(ctx: CanvasRenderingContext2D, payload: LoginPayload, palette: Palette, hot: string | null): Hotspot[] {
  panel(ctx, 1024, 741, palette.paper, palette.rule);
  const spots: Hotspot[] = [];
  ctx.fillStyle = palette.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText("网易云音乐 · 登录", 52, 84);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 54px ${FONT}`;
  ctx.fillText(payload.state === "done" ? payload.nickname || "已登录" : "扫码登录", 52, 150);
  ctx.fillStyle = palette.muted;
  ctx.font = `26px ${FONT}`;
  const steps = payload.state === "done" ? ["已经登录。你的每日推荐和我的歌单", "会出现在“音乐”页的来源板上。"] : ["1. 打开手机上的网易云音乐", "2. 扫一扫右边的二维码", "3. 在手机上点“确认登录”"];
  steps.forEach((line, i) => ctx.fillText(line, 52, 222 + i * 44));
  ctx.fillStyle = palette.accentInk;
  ctx.font = `bold 28px ${FONT}`;
  wrap(ctx, payload.message || STATE_TEXT[payload.state], 440, 3).forEach((line, i) => ctx.fillText(line, 52, 420 + i * 40));
  ctx.fillStyle = palette.muted;
  ctx.font = `19px ${FONT}`;
  wrap(ctx, "登录只在这台电脑上保存，用的是网易云音乐的非官方接口；不能绕过会员，会员歌曲只能试听片段。", 440, 3).forEach((line, i) => ctx.fillText(line, 52, 520 + i * 28));
  if (payload.qr) qrCode(ctx, payload.qr, 530, 112, 440);
  else {
    ctx.fillStyle = palette.chip;
    roundRect(ctx, 530, 112, 440, 440, 10);
    ctx.fill();
    ctx.fillStyle = palette.muted;
    ctx.font = `24px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(payload.state === "done" ? "✓" : "二维码会显示在这里", 750, 340);
    ctx.textAlign = "left";
  }
  if (payload.state === "done") button(ctx, "logout", "退出登录", 52, 636, 250, 68, false, hot === "logout", palette, spots);
  else button(ctx, "refresh", payload.qr ? "刷新二维码" : "获取二维码", 52, 636, 280, 68, true, hot === "refresh", palette, spots);
  return spots;
}

// ──────────────────────────────── the painter ────────────────────────────────

/** The painter of the music archives; `withMusicFaces` puts it beside the launcher's own. */
function musicPainter(): FacePainter {
  return {
    size: (variant: FaceVariant) => (variant === "detail" ? { width: 1024, height: 741 } : { width: 512, height: 370 }),
    paint(ctx: CanvasRenderingContext2D, variant: FaceVariant, item: StageItem, state: FaceState): Hotspot[] {
      const payload = item.payload as MusicPayload;
      const palette = state.dark ? DARK : LIGHT;
      ctx.save();
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      let spots: Hotspot[] = [];
      if (variant === "info") drawInfo(ctx, payload);
      else if (variant === "detail") {
        if (payload.kind === "song") spots = drawSongDetail(ctx, payload, palette, state.hot);
        else if (payload.kind === "playlist") spots = drawPlaylistDetail(ctx, payload, palette, state.hot);
        else spots = drawLoginDetail(ctx, payload, palette, state.hot);
      } else if (payload.kind === "song") drawSongCard(ctx, payload, palette);
      else if (payload.kind === "playlist") drawPlaylistCard(ctx, payload, palette);
      else drawLoginCard(ctx, payload, palette);
      ctx.restore();
      return spots;
    },
  };
}

/** A painter that prints the music archives itself and leaves everything else to `base`. */
export function withMusicFaces(base: FacePainter): FacePainter {
  const own = musicPainter();
  return {
    size: (variant) => base.size(variant),
    paint: (ctx, variant, item, state) => (isMusicPayload(item.payload) ? own.paint(ctx, variant, item, state) : base.paint(ctx, variant, item, state)),
  };
}

/** The characters the music faces may print, so that the font shards holding them are loaded before the first paint. */
export function musicFontSample(payloads: MusicPayload[]): string {
  let text = "歌曲歌单网易云音乐登录扫码点击选中再点一次播放暂停继续下一首打开全部时长正在已暂停会员无版权纯音乐请欣赏歌词没有时间轴不能滚动载入后在这里显示二维码刷新获取退出确认手机上用扫描过期出错了重试放大查看可这台电脑保存非官方接口绕过只能试听片段你的每日推荐和我的歌单会出现来源板编辑简介♪♫▶✓";
  for (const payload of payloads) {
    text += payload.kind === "login" ? payload.message + payload.nickname : payload.title + (payload.kind === "song" ? payload.artists + payload.album + payload.note + (payload.lyrics ? payload.lyrics.line + payload.lyrics.trans + payload.lyrics.before.join("") + payload.lyrics.after.join("") : "") : payload.creator + payload.description + payload.note);
  }
  return text;
}
