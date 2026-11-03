import { records } from "../data";

/**
 * Paints the label printed on the extracted cassette (a 1024 × 440 canvas):
 *
 *   VITRINE · 琉匣                         [ NEOFORGE ]
 *   新蒸程 1.7.5
 *   1.21.1 · NeoForge 21.1.248
 *   NO.003                                      ▼ mark
 */

const INK = "#171713";
const MUTED = "#878476";
const FONT = "MiSans, 'Microsoft YaHei', 'PingFang SC', sans-serif";

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, start: number, min: number, weight: string): string {
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

export function paintLabel(ctx: CanvasRenderingContext2D, index: number, mark: HTMLImageElement) {
  const record = records[Math.max(0, Math.min(records.length - 1, index))];
  ctx.fillStyle = INK;
  ctx.fillRect(12, 12, 1000, 6);
  ctx.fillRect(12, 419, 1000, 3);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = INK;
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText("VITRINE", 22, 76);
  ctx.fillStyle = MUTED;
  ctx.font = `28px ${FONT}`;
  ctx.fillText("琉匣 · LAUNCHER", 218, 76);

  const badge = record.badge.slice(0, 11) || "—";
  ctx.font = `bold 24px ${FONT}`;
  const badgeWidth = Math.min(300, Math.max(150, ctx.measureText(badge).width + 44));
  ctx.fillStyle = INK;
  ctx.fillRect(1002 - badgeWidth, 36, badgeWidth, 40);
  ctx.fillStyle = "#eee9de";
  ctx.textAlign = "center";
  ctx.fillText(badge, 1002 - badgeWidth / 2, 65);
  ctx.textAlign = "left";

  ctx.fillStyle = INK;
  const title = fit(ctx, record.title, 950, 104, 48, "bold");
  ctx.fillText(title, 22, 190);

  ctx.fillStyle = MUTED;
  const subtitle = fit(ctx, record.subtitle, 700, 36, 24, "normal");
  ctx.fillText(subtitle, 25, 244);

  ctx.fillStyle = INK;
  if (record.kind === "instance") {
    ctx.font = `bold 118px ${FONT}`;
    ctx.fillText(`NO.${String(record.number).padStart(3, "0")}`, 22, 372);
  } else {
    ctx.font = `bold 96px ${FONT}`;
    ctx.fillText(record.badge, 22, 366);
  }
  if (record.favorite) {
    ctx.fillStyle = "#1f9e8e";
    ctx.font = `bold 54px ${FONT}`;
    ctx.fillText("★", 700, 372);
  }
  if (mark.complete && mark.naturalWidth) ctx.drawImage(mark, 836, 270, 150, 150);
}

/** Every character the label may print, so the font shards that hold them can be loaded before drawing. */
export function labelFontSample(): string {
  return records.map((record) => `${record.title}${record.subtitle}${record.badge}`).join("") + "VITRINE琉匣LAUNCHER·NO.0123456789★";
}
