import type { Backdrop } from "../types";

/** A backdrop background defined once as color stops, so the live CSS
 * preview and the exported canvas paint can be derived from the same
 * numbers instead of drifting apart. A single stop means a solid fill. */
export interface BackdropPreset {
  id: string;
  label: string;
  stops: string[];
}

export const BACKDROP_PRESETS: BackdropPreset[] = [
  { id: "violet", label: "Violet", stops: ["#667eea", "#764ba2"] },
  { id: "sunset", label: "Sunset", stops: ["#ff7e5f", "#feb47b"] },
  { id: "ocean", label: "Ocean", stops: ["#2b5876", "#4e4376"] },
  { id: "mint", label: "Mint", stops: ["#43e97b", "#38f9d7"] },
  { id: "slate", label: "Slate", stops: ["#1e293b"] },
  { id: "paper", label: "Paper", stops: ["#f1f5f9"] },
];

export function presetById(id: string): BackdropPreset {
  return BACKDROP_PRESETS.find((p) => p.id === id) ?? BACKDROP_PRESETS[0];
}

/** CSS `background` value for the live preview. 135deg matches the
 * top-left -> bottom-right diagonal `paintBackdropBackground` draws. */
export function presetCss(id: string): string {
  const { stops } = presetById(id);
  return stops.length === 1 ? stops[0] : `linear-gradient(135deg, ${stops.join(", ")})`;
}

function paintBackdropBackground(ctx: CanvasRenderingContext2D, width: number, height: number, presetId: string) {
  const { stops } = presetById(presetId);
  if (stops.length === 1) {
    ctx.fillStyle = stops[0];
  } else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    stops.forEach((color, i) => gradient.addColorStop(i / (stops.length - 1), color));
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Wraps an already-flattened image canvas in the backdrop: padded gradient
 * or solid background, the image clipped to rounded corners, and an optional
 * drop shadow. Returns a new, larger canvas; `source` is left untouched. */
export function drawBackdrop(source: HTMLCanvasElement, backdrop: Backdrop): HTMLCanvasElement {
  const pad = Math.max(0, Math.round(backdrop.padding));
  const out = document.createElement("canvas");
  out.width = source.width + pad * 2;
  out.height = source.height + pad * 2;
  const ctx = out.getContext("2d")!;

  paintBackdropBackground(ctx, out.width, out.height, backdrop.preset);

  if (backdrop.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
    ctx.shadowBlur = Math.max(8, Math.round(pad * 0.5));
    ctx.shadowOffsetY = Math.max(4, Math.round(pad * 0.2));
    // The shadow is cast by an opaque rounded rect painted *underneath* the
    // screenshot rather than by the screenshot itself -- drawing the image
    // with a shadow set would also shadow every transparent pixel inside it.
    roundedRectPath(ctx, pad, pad, source.width, source.height, backdrop.cornerRadius);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundedRectPath(ctx, pad, pad, source.width, source.height, backdrop.cornerRadius);
  ctx.clip();
  ctx.drawImage(source, pad, pad);
  ctx.restore();

  return out;
}
