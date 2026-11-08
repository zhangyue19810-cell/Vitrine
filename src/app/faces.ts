import type { FacePainter, FaceState, FaceVariant, Hotspot, StageItem } from "../archive-stage";

/**
 * What is printed on the archives of the 3D stage. Three kinds of archive exist: an instance of the player's own
 * (home ring), an action ("new instance", "browse"…), and an online project (download row). Each can be painted as the
 * small face on its card, as the "info" face that appears while the pointer rests on it, and as the large "detail"
 * face of the archive that has been pulled out to the left (which also carries the clickable buttons of a project).
 *
 * Everything is drawn on 2D canvases that the stage turns into textures; the painter is pure drawing and holds no state.
 */

export interface InstancePayload {
  kind: "instance";
  title: string;
  subtitle: string;
  badge: string;
  number: number;
  favorite: boolean;
  running: boolean;
  /** Short lines for the hover face ("上次游玩 3 天前", "42 个模组"…). */
  facts: string[];
}

export interface ActionPayload {
  kind: "action";
  title: string;
  subtitle: string;
  badge: string;
}

export interface ProjectPayload {
  kind: "project";
  title: string;
  author: string;
  summary: string;
  downloads: string;
  updated: string;
  categories: string[];
  /** "模组" / "整合包" / "资源包" / "数据包" / "光影". */
  kindLabel: string;
  source: string;
  sides: string[];
  /** Decoded icon, when it has arrived (undefined: not yet, null: none available). */
  icon?: CanvasImageSource | null;
  installLabel: string;
}

export type FacePayload = InstancePayload | ActionPayload | ProjectPayload;

export const FONT = "MiSans, 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";

interface Palette {
  paper: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  chip: string;
  chipInk: string;
  rule: string;
  tile: string;
}

const LIGHT: Palette = { paper: "rgba(238,233,222,0.97)", ink: "#171713", muted: "#7b786b", accent: "#1f9e8e", accentInk: "#157060", chip: "rgba(23,23,19,0.08)", chipInk: "#3a3a33", rule: "#171713", tile: "#cfe7e1" };
const DARK: Palette = { paper: "rgba(27,34,37,0.97)", ink: "#e7efec", muted: "#8e9c9f", accent: "#4fd1bd", accentInk: "#7fe3d2", chip: "rgba(231,239,236,0.1)", chipInk: "#c5d3d0", rule: "#e7efec", tile: "#24413f" };
const INFO = { paper: "rgba(17,23,26,0.96)", ink: "#f1f6f4", muted: "#a9b8b9", accent: "#4fd1bd" };

/** Largest start size ≤ `start` (down to `min`) at which `text` fits in `maxWidth`; ends with an ellipsis if it still does not. */
export function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, start: number, min: number, weight = "bold"): string {
  let size = start;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && size > min) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Break `text` into at most `maxLines` lines that fit `maxWidth` (the current font): between any two CJK characters, or at spaces. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  const lines: string[] = [];
  let line = "";
  let lastSpace = -1;
  let index = 0;
  for (; index < chars.length; index++) {
    const ch = chars[index];
    if (line && ctx.measureText(line + ch).width > maxWidth) {
      if (ch !== " " && lastSpace > 0 && /[\x21-\x7e]/.test(ch) && lastSpace > line.length * 0.45) {
        lines.push(line.slice(0, lastSpace));
        line = line.slice(lastSpace + 1);
      } else {
        lines.push(line);
        line = "";
      }
      lastSpace = -1;
      if (lines.length === maxLines) break;
      if (ch === " ") continue;
    }
    line += ch;
    if (ch === " ") lastSpace = line.length - 1;
  }
  if (lines.length < maxLines && line) lines.push(line.trimEnd());
  else if (lines.length === maxLines && index < chars.length) {
    // More text than lines: end the last line with an ellipsis.
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string, ink: string, weight = "normal"): number {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const padding = size * 0.7;
  const width = ctx.measureText(text).width + padding * 2;
  const height = size * 1.7;
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padding, y + height / 2 + size * 0.04);
  ctx.textBaseline = "alphabetic";
  return width;
}

function icon(ctx: CanvasRenderingContext2D, payload: ProjectPayload, x: number, y: number, size: number, palette: Palette) {
  ctx.save();
  roundRect(ctx, x, y, size, size, size * 0.16);
  ctx.clip();
  const image = payload.icon;
  if (image) {
    ctx.fillStyle = palette.tile;
    ctx.fillRect(x, y, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, x, y, size, size);
  } else {
    // Not there yet (or none): a tile with the first letter, so the archive never looks empty.
    ctx.fillStyle = palette.tile;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = palette.accentInk;
    ctx.font = `bold ${size * 0.5}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(Array.from(payload.title)[0]?.toUpperCase() ?? "?", x + size / 2, y + size / 2 + size * 0.03);
  }
  ctx.restore();
  ctx.strokeStyle = palette.rule;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(1, size / 64);
  roundRect(ctx, x, y, size, size, size * 0.16);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function panel(ctx: CanvasRenderingContext2D, w: number, h: number, fill: string, rule?: string) {
  ctx.fillStyle = fill;
  roundRect(ctx, 6, 6, w - 12, h - 12, 12);
  ctx.fill();
  if (rule) {
    ctx.fillStyle = rule;
    ctx.fillRect(22, 18, w - 44, 4);
    ctx.fillRect(22, h - 22, w - 44, 2);
  }
}

// ──────────────────────────────── small faces (logical size 512 × 370) ────────────────────────────────

function drawLabelCard(ctx: CanvasRenderingContext2D, payload: InstancePayload | ActionPayload, palette: Palette) {
  panel(ctx, 512, 370, palette.paper, palette.rule);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 21px ${FONT}`;
  ctx.fillText("VITRINE", 26, 58);
  ctx.fillStyle = palette.muted;
  ctx.font = `14px ${FONT}`;
  ctx.fillText("琉匣 · LAUNCHER", 112, 58);

  const badge = payload.badge.slice(0, 11) || "—";
  ctx.font = `bold 13px ${FONT}`;
  const badgeWidth = Math.min(150, Math.max(80, ctx.measureText(badge).width + 26));
  ctx.fillStyle = palette.ink;
  ctx.fillRect(486 - badgeWidth, 40, badgeWidth, 24);
  ctx.fillStyle = palette.paper.replace(/rgba\((\d+),(\d+),(\d+),[\d.]+\)/, "rgb($1,$2,$3)");
  ctx.textAlign = "center";
  ctx.fillText(badge, 486 - badgeWidth / 2, 57);
  ctx.textAlign = "left";

  ctx.fillStyle = palette.ink;
  ctx.fillText(fit(ctx, payload.title, 462, 50, 24, "bold"), 26, 128);
  ctx.fillStyle = palette.muted;
  ctx.fillText(fit(ctx, payload.subtitle, 440, 20, 13, "normal"), 28, 162);

  if (payload.kind === "instance") {
    ctx.fillStyle = palette.ink;
    ctx.font = `bold 76px ${FONT}`;
    ctx.fillText(`NO.${String(payload.number).padStart(3, "0")}`, 24, 318);
    if (payload.favorite) {
      ctx.fillStyle = palette.accent;
      ctx.font = `bold 40px ${FONT}`;
      ctx.fillText("★", 440, 316);
    }
    if (payload.running) {
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(34, 218, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold 17px ${FONT}`;
      ctx.fillText("运行中", 50, 224);
    }
  } else {
    ctx.fillStyle = palette.ink;
    ctx.font = `bold 66px ${FONT}`;
    ctx.fillText(payload.badge, 24, 314);
  }
}

function drawProjectCard(ctx: CanvasRenderingContext2D, payload: ProjectPayload, palette: Palette) {
  panel(ctx, 512, 370, palette.paper, palette.rule);
  icon(ctx, payload, 28, 38, 118, palette);
  ctx.fillStyle = palette.muted;
  ctx.font = `13px ${FONT}`;
  ctx.fillText([payload.kindLabel, payload.source.toUpperCase()].filter(Boolean).join(" · "), 166, 54);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 30px ${FONT}`;
  const titleLines = wrap(ctx, payload.title, 322, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, 166, 88 + i * 34));
  ctx.fillStyle = palette.muted;
  ctx.font = `16px ${FONT}`;
  const authorY = 88 + titleLines.length * 34 + 6;
  if (payload.author) ctx.fillText(fit(ctx, payload.author, 322, 16, 12, "normal"), 166, Math.min(authorY, 150));

  ctx.fillStyle = palette.rule;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(28, 172, 456, 1.5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ink;
  ctx.font = `17px ${FONT}`;
  wrap(ctx, payload.summary, 456, 3).forEach((line, i) => ctx.fillText(line, 28, 204 + i * 25));

  let x = 28;
  for (const category of payload.categories.slice(0, 3)) {
    x += pill(ctx, category, x, 306, 13, palette.chip, palette.chipInk) + 8;
    if (x > 330) break;
  }
  ctx.fillStyle = palette.accentInk;
  ctx.font = `bold 22px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(`⬇ ${payload.downloads}`, 484, 326);
  ctx.textAlign = "left";
}

// ──────────────────────────────── hover face (logical size 512 × 370) ────────────────────────────────

function drawInfo(ctx: CanvasRenderingContext2D, payload: FacePayload) {
  panel(ctx, 512, 370, INFO.paper);
  ctx.fillStyle = INFO.accent;
  ctx.fillRect(26, 22, 56, 4);
  ctx.fillStyle = INFO.ink;
  ctx.font = `bold 26px ${FONT}`;
  const titleLines = wrap(ctx, payload.title, 460, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, 26, 64 + i * 32));
  let y = 64 + titleLines.length * 32 + 12;
  ctx.fillStyle = INFO.muted;
  ctx.font = `17px ${FONT}`;
  if (payload.kind === "project") {
    const lines = wrap(ctx, payload.summary, 460, 5);
    lines.forEach((line, i) => ctx.fillText(line, 26, y + i * 25));
    ctx.fillStyle = INFO.ink;
    ctx.font = `bold 17px ${FONT}`;
    const stats = [`⬇ ${payload.downloads}`, payload.updated ? `更新 ${payload.updated}` : "", ...payload.sides].filter(Boolean).join("   ·   ");
    ctx.fillText(fit(ctx, stats, 460, 17, 12, "bold"), 26, 322);
    ctx.fillStyle = INFO.muted;
    ctx.font = `14px ${FONT}`;
    ctx.fillText(payload.author ? `作者 ${payload.author}` : payload.source, 26, 346);
  } else if (payload.kind === "instance") {
    ctx.fillText(payload.subtitle, 26, y + 4);
    ctx.fillStyle = INFO.ink;
    payload.facts.slice(0, 5).forEach((fact, i) => ctx.fillText(fact, 26, y + 44 + i * 30));
    ctx.fillStyle = INFO.accent;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText("点击选中 · 再点一次进入详情", 26, 346);
  } else {
    wrap(ctx, payload.subtitle, 460, 4).forEach((line, i) => ctx.fillText(line, 26, y + i * 26));
    ctx.fillStyle = INFO.accent;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText("点击开始", 26, 346);
  }
}

// ──────────────────────────────── detail face (logical size 1024 × 741) ────────────────────────────────

function button(ctx: CanvasRenderingContext2D, id: string, label: string, x: number, y: number, w: number, h: number, primary: boolean, hot: boolean, palette: Palette, spots: Hotspot[]) {
  ctx.save();
  roundRect(ctx, x, y, w, h, h / 2);
  if (primary) {
    ctx.fillStyle = hot ? palette.accentInk : palette.accent;
    ctx.fill();
    ctx.fillStyle = "#ffffff";
  } else {
    ctx.fillStyle = hot ? palette.chip : "transparent";
    ctx.fill();
    ctx.strokeStyle = palette.ink;
    ctx.globalAlpha = hot ? 0.9 : 0.45;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.ink;
  }
  ctx.font = `bold ${primary ? 30 : 26}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  ctx.restore();
  spots.push({ id, x0: x / 1024, y0: y / 741, x1: (x + w) / 1024, y1: (y + h) / 741 });
}

function drawProjectDetail(ctx: CanvasRenderingContext2D, payload: ProjectPayload, palette: Palette, hot: string | null): Hotspot[] {
  panel(ctx, 1024, 741, palette.paper, palette.rule);
  const spots: Hotspot[] = [];
  icon(ctx, payload, 52, 62, 188, palette);
  ctx.fillStyle = palette.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText([payload.kindLabel, payload.source.toUpperCase()].filter(Boolean).join(" · "), 268, 84);
  ctx.fillStyle = palette.ink;
  ctx.font = `bold 54px ${FONT}`;
  const titleLines = wrap(ctx, payload.title, 700, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, 268, 146 + i * 60));
  // Author and chips sit under the last title line (a two line title pushes them down, so nothing overlaps).
  const authorY = 146 + (titleLines.length - 1) * 60 + 44;
  const chipsY = authorY + 18;
  ctx.fillStyle = palette.muted;
  ctx.font = `26px ${FONT}`;
  if (payload.author) ctx.fillText(fit(ctx, `作者 ${payload.author}`, 700, 26, 18, "normal"), 268, authorY);
  let x = 268;
  for (const side of payload.sides.slice(0, 2)) x += pill(ctx, side, x, chipsY, 19, palette.chip, palette.chipInk) + 10;
  for (const category of payload.categories.slice(0, 3)) {
    if (x > 760) break;
    x += pill(ctx, category, x, chipsY, 19, palette.chip, palette.chipInk) + 10;
  }

  const ruleY = Math.max(282, chipsY + 32 + 26);
  ctx.fillStyle = palette.rule;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(52, ruleY, 920, 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.ink;
  ctx.font = `27px ${FONT}`;
  wrap(ctx, payload.summary, 920, titleLines.length > 1 ? 4 : 5).forEach((line, i) => ctx.fillText(line, 52, ruleY + 54 + i * 40));

  const stats: [string, string][] = [["下载量", payload.downloads], ["最近更新", payload.updated || "—"], ["来源", payload.source]];
  stats.forEach(([label, value], i) => {
    const left = 52 + i * 310;
    ctx.fillStyle = palette.muted;
    ctx.font = `20px ${FONT}`;
    ctx.fillText(label, left, 566);
    ctx.fillStyle = palette.ink;
    ctx.font = `bold 32px ${FONT}`;
    ctx.fillText(fit(ctx, value, 280, 32, 20, "bold"), left, 604);
  });

  button(ctx, "install", payload.installLabel, 52, 636, 310, 68, true, hot === "install", palette, spots);
  button(ctx, "versions", "选择版本…", 382, 636, 220, 68, false, hot === "versions", palette, spots);
  button(ctx, "page", "主页 ↗", 622, 636, 190, 68, false, hot === "page", palette, spots);
  return spots;
}

// ──────────────────────────────── the painter ────────────────────────────────

export function createFacePainter(): FacePainter {
  return {
    size: (variant: FaceVariant) => (variant === "detail" ? { width: 1024, height: 741 } : { width: 512, height: 370 }),
    paint(ctx: CanvasRenderingContext2D, variant: FaceVariant, item: StageItem, state: FaceState): Hotspot[] {
      const payload = item.payload as FacePayload;
      const palette = state.dark ? DARK : LIGHT;
      ctx.save();
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      let spots: Hotspot[] = [];
      if (variant === "info") {
        drawInfo(ctx, payload);
      } else if (variant === "detail") {
        if (payload.kind === "project") spots = drawProjectDetail(ctx, payload, palette, state.hot);
        else {
          ctx.scale(2, 2.003);
          drawLabelCard(ctx, payload, palette);
        }
      } else if (payload.kind === "project") {
        drawProjectCard(ctx, payload, palette);
      } else {
        drawLabelCard(ctx, payload, palette);
      }
      ctx.restore();
      return spots;
    },
  };
}

/** All the characters the faces of `payloads` may print, so the font shards that hold them can be loaded first. */
export function fontSample(payloads: FacePayload[]): string {
  let text = "VITRINE琉匣LAUNCHER·NO.0123456789★⬇↗…作者更新下载量最近来源选择版本点击运行中客户端服务端模组整合包资源包数据包光影";
  for (const payload of payloads) {
    text += payload.title;
    if (payload.kind === "project") text += payload.author + payload.summary + payload.categories.join("") + payload.updated + payload.installLabel + payload.sides.join("");
    else text += payload.subtitle + payload.badge + (payload.kind === "instance" ? payload.facts.join("") : "");
  }
  return text;
}
