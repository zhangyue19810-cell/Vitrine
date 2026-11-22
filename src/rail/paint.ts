import { FONT, fit } from "../app/faces";
import type { PlateSpec } from "./model";

/**
 * Printing of the rail's plates and of the music disc on 2D canvases (the rail turns them into textures). Like the faces of
 * the archives this is pure drawing: it holds no state, so a plate can be printed again whenever its data changes.
 */

export interface RailPalette {
  paper: string;
  paperLow: string;
  ink: string;
  muted: string;
  accent: string;
  accentLow: string;
  onAccent: string;
  rule: string;
  track: string;
  night: string;
  nightInk: string;
}

export const RAIL_LIGHT: RailPalette = {
  paper: "#f0ebde",
  paperLow: "#ddd6c6",
  ink: "#171713",
  muted: "#7b786b",
  accent: "#c9922f",
  accentLow: "#a06f1c",
  onAccent: "#ffffff",
  rule: "rgba(23,23,19,0.22)",
  track: "rgba(23,23,19,0.16)",
  night: "rgba(17,23,26,0.9)",
  nightInk: "#f1f6f4",
};

export const RAIL_DARK: RailPalette = {
  paper: "#1c1b18",
  paperLow: "#111110",
  ink: "#ece5d6",
  muted: "#968f80",
  accent: "#e8b967",
  accentLow: "#b8843a",
  onAccent: "#1a1205",
  rule: "rgba(236,229,214,0.2)",
  track: "rgba(236,229,214,0.16)",
  night: "rgba(6,6,8,0.92)",
  nightInk: "#f4efe3",
};

function slab(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, top: number, bottom: number) {
  ctx.beginPath();
  ctx.moveTo(x + top, y);
  ctx.lineTo(x + w - top, y);
  ctx.arcTo(x + w, y, x + w, y + top, top);
  ctx.lineTo(x + w, y + h - bottom);
  ctx.arcTo(x + w, y + h, x + w - bottom, y + h, bottom);
  ctx.lineTo(x + bottom, y + h);
  ctx.arcTo(x, y + h, x, y + h - bottom, bottom);
  ctx.lineTo(x, y + top);
  ctx.arcTo(x, y, x + top, y, top);
  ctx.closePath();
}

function pillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  slab(ctx, x, y, w, h, h / 2, h / 2);
}

export interface PlatePaintState {
  /** The text cursor is in its visible half of the blink. */
  caret?: boolean;
}

/** Print one plate on a canvas whose logical size is the plate's width × height (the caller has applied the pixel ratio). */
export function paintPlate(ctx: CanvasRenderingContext2D, spec: PlateSpec, w: number, h: number, palette: RailPalette, state: PlatePaintState = {}) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const note = spec.kind === "note";
  const on = Boolean(spec.active) && !note;

  // The slab: paper (or the accent colour for the tab that is on); a "note" is a dark glass strip.
  slab(ctx, 0.5, 0.5, w - 1, h - 1, Math.min(12, h / 3), note ? Math.min(12, h / 3) : 5);
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  if (note) {
    gradient.addColorStop(0, palette.night);
    gradient.addColorStop(1, palette.night);
  } else if (on) {
    gradient.addColorStop(0, palette.accent);
    gradient.addColorStop(1, palette.accentLow);
  } else {
    gradient.addColorStop(0, palette.paper);
    gradient.addColorStop(1, palette.paperLow);
  }
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = on ? "rgba(255,255,255,0.35)" : palette.rule;
  ctx.stroke();
  if (!note) {
    // A thin light edge along the top, like the bevel of a card.
    ctx.strokeStyle = on ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(10, 1.5);
    ctx.lineTo(w - 10, 1.5);
    ctx.stroke();
  }

  const ink = note ? palette.nightInk : on ? palette.onAccent : palette.ink;
  const muted = note ? "rgba(241,246,244,0.62)" : on ? palette.onAccent : palette.muted;
  if (spec.disabled) ctx.globalAlpha = 0.42;

  switch (spec.kind) {
    case "tab": {
      ctx.font = `bold 12px ${FONT}`;
      const chip = spec.value ? ctx.measureText(spec.value).width + 12 : 0;
      const label = fit(ctx, spec.label, w - 20 - (chip ? chip + 7 : 0), 16, 11, "bold"); // leaves the fitted font set
      const labelWidth = ctx.measureText(label).width;
      const left = (w - labelWidth - (chip ? chip + 7 : 0)) / 2;
      ctx.fillStyle = ink;
      ctx.fillText(label, left, h / 2 + 1);
      if (spec.value) {
        const x = left + labelWidth + 7;
        pillPath(ctx, x, h / 2 - 9, chip, 18);
        ctx.fillStyle = on ? "rgba(255,255,255,0.28)" : palette.track;
        ctx.fill();
        ctx.fillStyle = ink;
        ctx.font = `bold 12px ${FONT}`;
        ctx.fillText(spec.value, x + 6, h / 2 + 1);
      }
      break;
    }
    case "segments": {
      const options = spec.options ?? [];
      ctx.fillStyle = muted;
      ctx.font = `13px ${FONT}`;
      ctx.fillText(spec.label, 14, h / 2 + 1);
      const labelWidth = ctx.measureText(spec.label).width;
      const cellsLeft = Math.max(labelWidth + 24, w - 12 - options.length * 38);
      const cellWidth = (w - 10 - cellsLeft) / Math.max(1, options.length);
      options.forEach((option, index) => {
        const x = cellsLeft + index * cellWidth;
        const chosen = index === spec.selected;
        pillPath(ctx, x + 1, 8, cellWidth - 2, h - 16);
        ctx.fillStyle = chosen ? palette.accent : palette.track;
        ctx.fill();
        ctx.fillStyle = chosen ? palette.onAccent : palette.ink;
        ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = "center";
        ctx.fillText(option, x + cellWidth / 2, h / 2 + 1);
        ctx.textAlign = "left";
      });
      break;
    }
    case "slider": {
      ctx.fillStyle = muted;
      ctx.font = `13px ${FONT}`;
      ctx.fillText(spec.label, 14, 14);
      if (spec.value) {
        ctx.fillStyle = ink;
        ctx.font = `bold 13px ${FONT}`;
        ctx.textAlign = "right";
        ctx.fillText(spec.value, w - 14, 14);
        ctx.textAlign = "left";
      }
      const amount = Math.min(1, Math.max(0, spec.amount ?? 0));
      const left = 14;
      const right = w - 14;
      const y = h - 13;
      ctx.lineCap = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = palette.track;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.strokeStyle = palette.accent;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + (right - left) * amount, y);
      ctx.stroke();
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(left + (right - left) * amount, y, 6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "field": {
      ctx.fillStyle = muted;
      ctx.font = `bold 17px ${FONT}`;
      ctx.fillText("⌕", 14, h / 2 + 1);
      const text = spec.text ?? "";
      const maxWidth = w - 52;
      ctx.font = `15px ${FONT}`;
      let shown = text;
      // A long text shows its end, where the cursor is.
      while (shown.length > 1 && ctx.measureText(shown).width > maxWidth) shown = shown.slice(1);
      ctx.fillStyle = text ? ink : muted;
      const printed = text ? shown : (spec.placeholder ?? "");
      ctx.fillText(fit(ctx, printed, maxWidth, 15, 12, "normal"), 38, h / 2 + 1);
      if (spec.focused && state.caret) {
        ctx.font = `15px ${FONT}`;
        const x = 38 + (text ? ctx.measureText(shown).width : 0) + 1;
        ctx.fillStyle = palette.accent;
        ctx.fillRect(x, h / 2 - 9, 2, 18);
      }
      if (spec.focused) {
        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 2;
        slab(ctx, 1.5, 1.5, w - 3, h - 3, Math.min(12, h / 3), 5);
        ctx.stroke();
      }
      break;
    }
    case "note": {
      const lines: [string | undefined, number, string, string][] = [
        [spec.label, 17, "bold", ink],
        [spec.value, 13, "normal", muted],
        [spec.text, 14, "normal", palette.accent],
      ];
      const shown = lines.filter(([text]) => text);
      const lineHeight = h / (shown.length + 0.4);
      shown.forEach(([text, size, weight, color], index) => {
        ctx.fillStyle = color;
        const fitted = fit(ctx, text!, w - 28, size, 11, weight);
        ctx.fillText(fitted, 14, lineHeight * (index + 0.7));
      });
      break;
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------ the disc

/** The part of the disc that turns: vinyl with its grooves, and the label that carries the cover of the song. */
export function paintDisc(ctx: CanvasRenderingContext2D, size: number, palette: RailPalette, cover: CanvasImageSource | null, empty: boolean) {
  const c = size / 2;
  const r = size / 2 - 1;
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  const body = ctx.createRadialGradient(c, c, r * 0.1, c, c, r);
  body.addColorStop(0, "#23292b");
  body.addColorStop(0.7, "#15191b");
  body.addColorStop(1, "#0a0c0d");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  // Grooves: many hair-thin rings with a few wider bands where the light would catch.
  for (let ring = r * 0.5; ring < r * 0.97; ring += r * 0.017) {
    ctx.strokeStyle = `rgba(255,255,255,${0.025 + 0.03 * Math.abs(Math.sin(ring * 0.9))})`;
    ctx.lineWidth = Math.max(0.5, r * 0.004);
    ctx.beginPath();
    ctx.arc(c, c, ring, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const band of [0.62, 0.78, 0.9]) {
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = r * 0.035;
    ctx.beginPath();
    ctx.arc(c, c, r * band, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Two opposite glints that rotate with the disc.
  if (typeof ctx.createConicGradient === "function") {
    const sheen = ctx.createConicGradient(Math.PI * 0.25, c, c);
    sheen.addColorStop(0, "rgba(255,255,255,0)");
    sheen.addColorStop(0.06, "rgba(255,255,255,0.16)");
    sheen.addColorStop(0.12, "rgba(255,255,255,0)");
    sheen.addColorStop(0.5, "rgba(255,255,255,0)");
    sheen.addColorStop(0.56, "rgba(255,255,255,0.12)");
    sheen.addColorStop(0.62, "rgba(255,255,255,0)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.arc(c, c, r * 0.96, 0, Math.PI * 2);
    ctx.arc(c, c, r * 0.5, 0, Math.PI * 2, true);
    ctx.fill();
  }
  // The label.
  const label = r * 0.47;
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, label, 0, Math.PI * 2);
  ctx.clip();
  if (cover) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cover, c - label, c - label, label * 2, label * 2);
  } else {
    const fill = ctx.createLinearGradient(c - label, c - label, c + label, c + label);
    fill.addColorStop(0, palette.accent);
    fill.addColorStop(1, palette.accentLow);
    ctx.fillStyle = fill;
    ctx.fillRect(c - label, c - label, label * 2, label * 2);
    ctx.fillStyle = palette.onAccent;
    ctx.font = `bold ${label * 0.9}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(empty ? "♪" : "…", c, c + label * 0.05);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = Math.max(1, r * 0.012);
  ctx.beginPath();
  ctx.arc(c, c, label, 0, Math.PI * 2);
  ctx.stroke();
  // The spindle hole.
  ctx.fillStyle = "#0b0d0e";
  ctx.beginPath();
  ctx.arc(c, c, r * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = Math.max(1, r * 0.012);
  ctx.stroke();
  ctx.restore();
}

export const DISC_TICKS = 72;

/**
 * The ring of ticks around the disc: the ticks up to the playhead are lit. `ghost` (a turn in 0…1) is where a click on the
 * rim would seek to; it is drawn while the pointer is on the rim. `size` is the side of the canvas, the disc has radius `radius`.
 */
export function paintDiscRing(ctx: CanvasRenderingContext2D, size: number, radius: number, progress: number | null, ghost: number | null, palette: RailPalette, dim: boolean) {
  const c = size / 2;
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = "round";
  const lit = progress === null ? -1 : Math.floor(Math.min(0.9999, Math.max(0, progress)) * DISC_TICKS);
  const ghostTick = ghost === null ? -1 : Math.floor(Math.min(0.9999, Math.max(0, ghost)) * DISC_TICKS);
  for (let tick = 0; tick < DISC_TICKS; tick++) {
    const angle = ((tick + 0.5) / DISC_TICKS) * Math.PI * 2 - Math.PI / 2;
    const major = tick % 6 === 0;
    const head = tick === lit;
    const inner = radius * (major || head ? 1.04 : 1.07);
    const outer = radius * (head ? 1.2 : major ? 1.16 : 1.12);
    const passed = tick <= lit;
    ctx.lineWidth = Math.max(1.5, radius * (head ? 0.06 : 0.04));
    ctx.strokeStyle = passed ? palette.accent : dim ? "rgba(147,162,164,0.35)" : palette.track;
    if (tick === ghostTick && !head) ctx.strokeStyle = palette.ink;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(angle) * inner, c + Math.sin(angle) * inner);
    ctx.lineTo(c + Math.cos(angle) * outer, c + Math.sin(angle) * outer);
    ctx.stroke();
  }
  ctx.restore();
}
