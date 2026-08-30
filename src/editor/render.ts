import type { ArrowShape, ImgPoint, Shape, SpotlightShape } from "./types";
import { rotationCenter, rotationOf } from "./types";
// Shared with the adjustment pipeline so both agree on whether canvas
// filters can be trusted in this webview.
import { supportsCanvasFilter } from "./tools/adjust";

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



/** Blurs a region of `source` in place on `ctx`.
 *
 * A blurred region has to be built on its own canvas and clipped, not blurred
 * straight onto `ctx`: `ctx.filter` applies to the draw call, so sampling the
 * neighbouring pixels of a sub-rect would smear the region's own edges into
 * the surrounding image. Drawing an oversized source area and clipping to the
 * shape keeps the edge sharp while the interior samples real neighbours.
 *
 * Falls back to repeated downscale/upscale (a box-blur approximation) where
 * `ctx.filter` is unavailable -- visually close enough for a censor, and the
 * region stays genuinely unreadable either way, which is the actual
 * requirement. */
function drawBlurredRegion(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  strength: number,
) {
  const left = w < 0 ? x + w : x;
  const top = h < 0 ? y + h : y;
  const width = Math.max(1, Math.round(Math.abs(w)));
  const height = Math.max(1, Math.round(Math.abs(h)));
  const radius = Math.max(2, strength / 2);

  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d")!;

  if (supportsCanvasFilter()) {
    // Pad the sampled area by the blur radius so the edges blend with real
    // neighbouring pixels instead of the layer's transparent border.
    const pad = Math.ceil(radius * 3);
    lctx.filter = `blur(${radius}px)`;
    lctx.drawImage(
      source,
      left - pad,
      top - pad,
      width + pad * 2,
      height + pad * 2,
      -pad,
      -pad,
      width + pad * 2,
      height + pad * 2,
    );
    lctx.filter = "none";
  } else {
    const steps = 3;
    const factor = Math.max(2, Math.round(radius));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(width / factor));
    small.height = Math.max(1, Math.round(height / factor));
    const sctx = small.getContext("2d")!;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(source, left, top, width, height, 0, 0, small.width, small.height);
    for (let i = 1; i < steps; i++) {
      sctx.drawImage(small, 0, 0, small.width, small.height);
    }
    lctx.imageSmoothingEnabled = true;
    lctx.drawImage(small, 0, 0, small.width, small.height, 0, 0, width, height);
  }

  ctx.drawImage(layer, left, top);
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

/** An open (unfilled) head: two strokes forming a V, rather than a filled
 * triangle, so the shaft appears to continue through it. */
function drawOpenHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

/** The point on a quadratic curve at `t`, and the direction it's heading --
 * the head has to be angled along the curve's own tangent, not along the
 * straight line between the endpoints, or a strongly curved arrow points
 * visibly wide of where it lands. */
function quadraticAt(
  p0: ImgPoint,
  c: ImgPoint,
  p1: ImgPoint,
  t: number,
): { x: number; y: number; dx: number; dy: number } {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    dx: 2 * mt * (c.x - p0.x) + 2 * t * (p1.x - c.x),
    dy: 2 * mt * (c.y - p0.y) + 2 * t * (p1.y - c.y),
  };
}

/** Draws the shaft and returns, for each end, a point just "behind" it along
 * the shaft -- the reference the head angles itself against. Straight shafts
 * use the opposite endpoint; curved ones use the local tangent. */
function drawArrowShaft(ctx: CanvasRenderingContext2D, s: ArrowShape): { from: ImgPoint; to: ImgPoint } {
  const start = { x: s.x1, y: s.y1 };
  const end = { x: s.x2, y: s.y2 };
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  if (!s.curve) {
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    return { from: start, to: end };
  }
  ctx.quadraticCurveTo(s.curve.x, s.curve.y, end.x, end.y);
  ctx.stroke();
  const atEnd = quadraticAt(start, s.curve, end, 1);
  const atStart = quadraticAt(start, s.curve, end, 0);
  return {
    // Points *behind* each tip along the curve, so `drawArrowHead`'s
    // atan2(to - from) yields the tangent direction at that tip.
    from: { x: end.x - atEnd.dx, y: end.y - atEnd.dy },
    to: { x: start.x + atStart.dx, y: start.y + atStart.dy },
  };
}

/** The banner *shaft*: a solid wedge that widens from the tail toward the
 * tip. Filled rather than stroked, so `strokeWidth` reads as its thickness.
 *
 * Only the shaft -- the head is drawn separately by the usual head routines,
 * which is what lets a banner carry any head style (or none). */
function drawBannerShaft(ctx: CanvasRenderingContext2D, s: ArrowShape, headLen: number) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  if (len < 1) return;
  const tailHalf = s.strokeWidth * 0.35;
  const tipHalf = s.strokeWidth * 1.1;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  // Stop short of the tip so a head sits on the end of the shaft rather
  // than on top of it; with no head the shaft runs the whole length.
  const stop = Math.max(0, len - headLen * 0.6);
  const ex = s.x1 + Math.cos(angle) * stop;
  const ey = s.y1 + Math.sin(angle) * stop;

  ctx.beginPath();
  ctx.moveTo(s.x1 + nx * tailHalf, s.y1 + ny * tailHalf);
  ctx.lineTo(ex + nx * tipHalf, ey + ny * tipHalf);
  ctx.lineTo(ex - nx * tipHalf, ey - ny * tipHalf);
  ctx.lineTo(s.x1 - nx * tailHalf, s.y1 - ny * tailHalf);
  ctx.closePath();
  ctx.fill();
}

/** A swallowtail notch at the arrow's tail. */
function drawTail(ctx: CanvasRenderingContext2D, s: ArrowShape, size: number) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  ctx.beginPath();
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(s.x1 + size * Math.cos(angle - Math.PI / 4), s.y1 + size * Math.sin(angle - Math.PI / 4));
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(s.x1 + size * Math.cos(angle + Math.PI / 4), s.y1 + size * Math.sin(angle + Math.PI / 4));
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, opts: RenderOptions) {
  ctx.save();
  // Rotation is applied as a transform around the shape's own center, so
  // every case below keeps drawing in unrotated coordinates.
  const rotation = rotationOf(s);
  if (rotation !== 0) {
    const c = rotationCenter(s);
    ctx.translate(c.x, c.y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-c.x, -c.y);
  }
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
    case "arrow": {
      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      ctx.fillStyle = s.stroke;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const style = s.style ?? "single";
      const head = 10 + s.strokeWidth * 2;

      // A banner shaft is always straight: tapering along a curve would need
      // offset-curve math well beyond what the shape earns, so a curved
      // arrow falls back to the stroked shaft.
      const banner = s.banner === true && !s.curve;
      const { from, to } = banner
        ? (drawBannerShaft(ctx, s, style === "none" ? 0 : head),
          { from: { x: s.x1, y: s.y1 }, to: { x: s.x2, y: s.y2 } })
        : drawArrowShaft(ctx, s);
      // A headless arrow is a plain line -- the shaft is the whole shape.
      if (style === "none") break;
      if (style === "open") {
        drawOpenHead(ctx, from.x, from.y, s.x2, s.y2, head);
      } else {
        drawArrowHead(ctx, from.x, from.y, s.x2, s.y2, head);
      }
      if (style === "double") {
        drawArrowHead(ctx, to.x, to.y, s.x1, s.y1, head);
      }
      if (style === "tail") {
        drawTail(ctx, s, head * 0.7);
      }
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
      const mode = s.mode ?? "pixelate";
      if (mode === "solid") {
        ctx.fillStyle = s.color ?? "#000000";
        ctx.fillRect(s.x, s.y, s.w, s.h);
        break;
      }
      if (!opts.baseImage) break;
      const block = Math.max(4, s.blockSize);
      if (mode === "blur") {
        drawBlurredRegion(ctx, opts.baseImage, s.x, s.y, s.w, s.h, block);
        break;
      }
      const tmp = document.createElement("canvas");
      tmp.width = Math.max(1, Math.round(s.w / block));
      tmp.height = Math.max(1, Math.round(s.h / block));
      const tmpCtx = tmp.getContext("2d")!;
      tmpCtx.imageSmoothingEnabled = true;
      tmpCtx.drawImage(opts.baseImage, s.x, s.y, s.w, s.h, 0, 0, tmp.width, tmp.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, s.x, s.y, s.w, s.h);
      ctx.imageSmoothingEnabled = true;
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
      // Weight 600 is the original, unbolded look; the bold toggle steps up
      // to 700 rather than making unbolded text lighter than it has been.
      const weight = s.bold ? 700 : 600;
      const slant = s.italic ? "italic " : "";
      ctx.font = `${slant}${weight} ${s.fontSize}px Inter, sans-serif`;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      const lines = s.text.split("\n");
      const lineHeight = s.fontSize * 1.3;
      const widths = lines.map((l) => ctx.measureText(l).width);
      const widest = Math.max(0, ...widths);
      const align = s.align ?? "left";
      // Each line is offset within the block's own width, so alignment is
      // relative to the longest line rather than to the whole image.
      const offsetFor = (i: number) =>
        align === "center" ? (widest - widths[i]) / 2 : align === "right" ? widest - widths[i] : 0;

      const bg = s.bgColor !== undefined ? s.bgColor : s.background ? "rgba(0,0,0,0.6)" : null;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(s.x - 4, s.y - 2, widest + 8, lineHeight * lines.length);
      }

      ctx.fillStyle = s.color;
      lines.forEach((line, i) => {
        const x = s.x + offsetFor(i);
        const y = s.y + i * lineHeight;
        ctx.fillText(line, x, y);
        if (s.underline && line.length > 0) {
          // Canvas has no underline, so it's drawn: just under the baseline,
          // thickness scaled off the font size so it holds up when zoomed.
          const thickness = Math.max(1, s.fontSize / 14);
          ctx.fillRect(x, y + s.fontSize * 1.05, widths[i], thickness);
        }
      });
      break;
    }
    case "stamp": {
      // Emoji render through the system emoji font; where none is installed
      // the glyphs fall back to monochrome, which still reads correctly.
      ctx.font = `${s.size}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.emoji, s.x, s.y);
      break;
    }
    case "loupe": {
      if (!opts.baseImage) break;
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.clip();
      // Draw the whole image scaled about the lens center, so the pixels
      // under the lens stay put while everything around them magnifies out
      // of the clip region.
      ctx.translate(s.x, s.y);
      ctx.scale(s.factor, s.factor);
      ctx.translate(-s.x, -s.y);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(opts.baseImage, 0, 0);
      ctx.restore();

      ctx.lineWidth = s.strokeWidth;
      ctx.strokeStyle = s.stroke;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.stroke();
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
