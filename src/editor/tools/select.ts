import type { HandleId, ImgPoint, RectHandleId, Shape } from "../types";
import { hitTest, isEndpointLike, isRectLike, shapeBounds } from "../types";
import { snapAngle } from "./constrain";

/** Topmost shape under the point, searched back-to-front (last drawn = on top). */
export function pickShape(shapes: Shape[], point: ImgPoint): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitTest(shapes[i], point)) return shapes[i];
  }
  return null;
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate":
    case "spotlight":
    case "image":
    case "text":
    case "marker":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "arrow":
    case "line":
      return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
    case "freehand":
      return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/** A copy of `shape` with a fresh id, offset by (dx, dy). Offsetting goes
 * through `moveShape` so every shape kind travels correctly -- notably
 * freehand, whose position lives in `points` rather than an `x`/`y` pair. */
export function cloneShape(shape: Shape, dx = 0, dy = 0): Shape {
  return { ...moveShape(shape, dx, dy), id: crypto.randomUUID() };
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Nearest handle to `point` within `pad` image-space pixels, or null. */
export function pickHandle(handles: { id: HandleId; x: number; y: number }[], point: ImgPoint, pad: number): HandleId | null {
  let best: { id: HandleId; dist: number } | null = null;
  for (const h of handles) {
    const dist = Math.hypot(h.x - point.x, h.y - point.y);
    if (dist <= pad && (!best || dist < best.dist)) best = { id: h.id, dist };
  }
  return best?.id ?? null;
}

export function resizeBounds(orig: Bounds, handle: RectHandleId, point: ImgPoint, keepAspect: boolean): Bounds {
  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;
  const aspect = orig.w / (orig.h || 1);
  const isCorner = handle === "nw" || handle === "ne" || handle === "se" || handle === "sw";

  if (isCorner) {
    const anchorX = handle === "nw" || handle === "sw" ? right : orig.x;
    const anchorY = handle === "nw" || handle === "ne" ? bottom : orig.y;
    let newW = Math.abs(point.x - anchorX);
    let newH = Math.abs(point.y - anchorY);
    if (keepAspect) {
      if (newW / (newH || 1) > aspect) {
        newH = newW / aspect;
      } else {
        newW = newH * aspect;
      }
    }
    const signX = point.x < anchorX ? -1 : 1;
    const signY = point.y < anchorY ? -1 : 1;
    const cornerX = anchorX + signX * newW;
    const cornerY = anchorY + signY * newH;
    return {
      x: Math.min(anchorX, cornerX),
      y: Math.min(anchorY, cornerY),
      w: Math.max(1, newW),
      h: Math.max(1, newH),
    };
  }

  if (handle === "n" || handle === "s") {
    const anchorY = handle === "n" ? bottom : orig.y;
    const newH = Math.abs(point.y - anchorY);
    return { x: orig.x, y: Math.min(anchorY, point.y), w: orig.w, h: Math.max(1, newH) };
  }

  // "e" | "w"
  const anchorX = handle === "w" ? right : orig.x;
  const newW = Math.abs(point.x - anchorX);
  return { x: Math.min(anchorX, point.x), y: orig.y, w: Math.max(1, newW), h: orig.h };
}

export function resizeShape(shape: Shape, handle: HandleId, point: ImgPoint, keepAspect: boolean): Shape {
  if (isEndpointLike(shape) && (handle === "start" || handle === "end")) {
    const fixed = handle === "start" ? { x: shape.x2, y: shape.y2 } : { x: shape.x1, y: shape.y1 };
    const moved = keepAspect ? snapAngle(fixed, point) : point;
    return handle === "start"
      ? { ...shape, x1: moved.x, y1: moved.y }
      : { ...shape, x2: moved.x, y2: moved.y };
  }

  if (!isRectLike(shape) || handle === "start" || handle === "end") return shape;

  const orig = shapeBounds(shape);
  const next = resizeBounds(orig, handle, point, keepAspect);

  if (shape.kind === "freehand") {
    const sx = orig.w === 0 ? 1 : next.w / orig.w;
    const sy = orig.h === 0 ? 1 : next.h / orig.h;
    return {
      ...shape,
      points: shape.points.map((p) => ({
        x: next.x + (p.x - orig.x) * sx,
        y: next.y + (p.y - orig.y) * sy,
      })),
    };
  }

  return { ...shape, x: next.x, y: next.y, w: next.w, h: next.h };
}
