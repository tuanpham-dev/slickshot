import type { Shape, SpotlightShape } from "./types";

export interface RenderOptions {
  baseImage?: CanvasImageSource | null;
  selectedId?: string | null;
  /** Called once an inserted image finishes decoding, so the caller can
   * re-render -- image shapes draw nothing on the pass that first requests
   * them (decoding is async) and would otherwise stay invisible until some
   * unrelated state change happened to trigger another render. */
  onImageLoad?: () => void;
}

/** Decoded `<img>` elements for image shapes, keyed by data URL so a
 * duplicated (or undone/redone) image shape reuses the same decode instead
 * of paying for another one. Module-level: the editor window is pre-warmed
 * and reused across captures, and entries are cheap to keep. */
const imageElements = new Map<string, HTMLImageElement>();

function imageElement(dataUrl: string, onLoad?: () => void): HTMLImageElement {
  let el = imageElements.get(dataUrl);
  if (!el) {
    el = new Image();
    el.onload = () => onLoad?.();
    el.src = dataUrl;
    imageElements.set(dataUrl, el);
  }
  return el;
}

function isDecoded(el: HTMLImageElement): boolean {
  return el.complete && el.naturalWidth > 0;
}

/** Resolves once every image shape in `shapes` has decoded, so an export can
 * flatten them instead of silently dropping the ones still in flight. */
export async function preloadImageShapes(shapes: Shape[]): Promise<void> {
  const pending = shapes
    .filter((s): s is Extract<Shape, { kind: "image" }> => s.kind === "image")
    .map((s) => imageElement(s.dataUrl))
    .filter((el) => !isDecoded(el))
    .map(
      (el) =>
        new Promise<void>((resolve) => {
          // Resolve (not reject) on error: one unreadable image shouldn't
          // fail the whole export -- it just renders as nothing, exactly as
          // it already appears on screen.
          el.addEventListener("load", () => resolve(), { once: true });
          el.addEventListener("error", () => resolve(), { once: true });
        }),
    );
  await Promise.all(pending);
}

/** Begins a rounded-rect path, clamping the radius to half the smaller side
 * so an over-large radius reads as "fully rounded" instead of letting the
 * corner arcs cross each other. Negative `w`/`h` (a shape stored from a
 * right-to-left drag) are normalized first.
 *
 * `ctx.roundRect` needs WebKitGTK >= 2.38; the manual `arcTo` path is an
 * equivalent fallback for older webviews. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const left = w < 0 ? x + w : x;
  const top = h < 0 ? y + h : y;
  const width = Math.abs(w);
  const height = Math.abs(h);
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));

  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(left, top, width, height, r);
    return;
  }
  const right = left + width;
  const bottom = top + height;
  ctx.moveTo(left + r, top);
  ctx.arcTo(right, top, right, bottom, r);
  ctx.arcTo(right, bottom, left, bottom, r);
  ctx.arcTo(left, bottom, left, top, r);
  ctx.arcTo(left, top, right, top, r);
  ctx.closePath();
}

/** Paints the single shared dim layer for every spotlight shape: fill the
 * whole canvas, then punch each spotlight's rect back out with
 * `destination-out`. Built on its own canvas because the punch-through has
 * to erase only the dim fill -- run directly on `ctx` it would also erase
 * whatever was already drawn underneath. */
function drawSpotlightLayer(ctx: CanvasRenderingContext2D, spotlights: SpotlightShape[]) {
  const dim = Math.max(...spotlights.map((s) => s.dimOpacity));
  const layer = document.createElement("canvas");
  layer.width = ctx.canvas.width;
  layer.height = ctx.canvas.height;
  const lctx = layer.getContext("2d")!;
  lctx.fillStyle = `rgba(0, 0, 0, ${dim})`;
  lctx.fillRect(0, 0, layer.width, layer.height);
  lctx.globalCompositeOperation = "destination-out";
  // Opaque fill: `destination-out` erases in proportion to the *source*
  // alpha, so reusing the dim layer's translucent fillStyle here would only
  // partially clear each hole (leaving the spotlit area visibly muted).
  lctx.fillStyle = "#000";
  for (const s of spotlights) {
    if (s.form === "ellipse") {
      lctx.beginPath();
      lctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
      lctx.fill();
    } else if ((s.radius ?? 0) > 0) {
      roundedRectPath(lctx, s.x, s.y, s.w, s.h, s.radius!);
      lctx.fill();
    } else {
      lctx.fillRect(s.x, s.y, s.w, s.h);
    }
  }
  ctx.drawImage(layer, 0, 0);
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, opts: RenderOptions) {
  ctx.save();
  switch (s.kind) {
    case "rect": {
      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      if ((s.radius ?? 0) > 0) {
        // One path, filled then stroked -- rebuilding it between the two
        // would double the arc math for no gain.
        roundedRectPath(ctx, s.x, s.y, s.w, s.h, s.radius!);
        if (s.fill) {
          ctx.fillStyle = s.fill;
          ctx.fill();
        }
        ctx.stroke();
        break;
      }
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fillRect(s.x, s.y, s.w, s.h);
      }
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      break;
    }
    case "ellipse": {
      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      ctx.beginPath();
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      ctx.stroke();
      break;
    }
    case "line": {
      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      ctx.fillStyle = s.stroke;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      drawArrowHead(ctx, s.x1, s.y1, s.x2, s.y2, 10 + s.strokeWidth * 2);
      break;
    }
    case "freehand": {
      if (s.points.length < 2) break;
      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      break;
    }
    case "highlight": {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    }
    case "pixelate": {
      if (opts.baseImage) {
        const block = Math.max(4, s.blockSize);
        const tmp = document.createElement("canvas");
        tmp.width = Math.max(1, Math.round(s.w / block));
        tmp.height = Math.max(1, Math.round(s.h / block));
        const tmpCtx = tmp.getContext("2d")!;
        tmpCtx.imageSmoothingEnabled = true;
        tmpCtx.drawImage(opts.baseImage, s.x, s.y, s.w, s.h, 0, 0, tmp.width, tmp.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, s.x, s.y, s.w, s.h);
        ctx.imageSmoothingEnabled = true;
      }
      break;
    }
    case "spotlight":
      // Drawn by `drawSpotlightLayer` in one shared pass, not per-shape.
      break;
    case "image": {
      const el = imageElement(s.dataUrl, opts.onImageLoad);
      if (isDecoded(el)) ctx.drawImage(el, s.x, s.y, s.w, s.h);
      break;
    }
    case "text": {
      ctx.font = `600 ${s.fontSize}px Inter, sans-serif`;
      ctx.textBaseline = "top";
      const lines = s.text.split("\n");
      const lineHeight = s.fontSize * 1.3;
      if (s.background) {
        const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(s.x - 4, s.y - 2, widest + 8, lineHeight * lines.length);
      }
      ctx.fillStyle = s.color;
      lines.forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lineHeight));
      break;
    }
    case "marker": {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.fillStyle = "#fff";
      const fontSize = Math.max(10, Math.round(s.radius * 1.0));
      ctx.font = `700 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(s.number), s.x, s.y + 1);
      break;
    }
  }
  ctx.restore();
}

export function render(ctx: CanvasRenderingContext2D, shapes: Shape[], opts: RenderOptions = {}) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // The dim layer goes down first so every other annotation draws on top of
  // it at full brightness -- arrows and labels stay readable no matter where
  // they sit relative to a spotlight.
  const spotlights = shapes.filter((s): s is SpotlightShape => s.kind === "spotlight");
  if (spotlights.length > 0) drawSpotlightLayer(ctx, spotlights);
  for (const s of shapes) {
    drawShape(ctx, s, opts);
  }
}
