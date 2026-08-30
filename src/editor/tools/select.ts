import type { HandleId, ImgPoint, RectHandleId, Shape } from "../types";
import {
  hitTest,
  isEndpointLike,
  isRectLike,
  isRotatable,
  rotationCenter,
  shapeBounds,
  toLocalPoint,
} from "../types";
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
    case "stamp":
    case "loupe":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "arrow":
      return {
        ...shape,
        x1: shape.x1 + dx,
        y1: shape.y1 + dy,
        x2: shape.x2 + dx,
        y2: shape.y2 + dy,
        // The control point is an absolute coordinate, so it has to travel
        // with the endpoints or the curve flattens as the arrow moves.
        curve: shape.curve ? { x: shape.curve.x + dx, y: shape.curve.y + dy } : undefined,
      };
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

/** Mirrors a shape across the image's horizontal or vertical midline, for
 * baking a flip into the document (see the store's `flipImage`).
 *
 * Every coordinate the shape owns has to move, not just its origin: a rect's
 * left edge becomes its right, an arrow's endpoints swap sides, a freehand
 * path mirrors point by point, and a rotation reverses direction because the
 * mirrored image turns the opposite way. */
export function mirrorShape(shape: Shape, axis: "h" | "v", imageWidth: number, imageHeight: number): Shape {
  // Mirrored x for a point, and for a box whose x is its left edge.
  const mx = (x: number) => imageWidth - x;
  const my = (y: number) => imageHeight - y;
  const flipRotation = (r?: number) => (r === undefined || r === 0 ? r : (360 - r) % 360);

  switch (shape.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate":
    case "spotlight":
    case "image": {
      const next =
        axis === "h"
          ? { ...shape, x: mx(shape.x + shape.w) }
          : { ...shape, y: my(shape.y + shape.h) };
      return "rotation" in next ? { ...next, rotation: flipRotation(next.rotation) } : next;
    }
    case "text":
    case "marker":
    case "stamp":
    case "loupe": {
      // These are positioned by a point (top-left for text, center for the
      // rest), so only that point moves -- there is no extent to re-anchor.
      const next = axis === "h" ? { ...shape, x: mx(shape.x) } : { ...shape, y: my(shape.y) };
      return "rotation" in next ? { ...next, rotation: flipRotation(next.rotation) } : next;
    }
    case "arrow":
      return axis === "h"
        ? {
            ...shape,
            x1: mx(shape.x1),
            x2: mx(shape.x2),
            curve: shape.curve ? { x: mx(shape.curve.x), y: shape.curve.y } : undefined,
          }
        : {
            ...shape,
            y1: my(shape.y1),
            y2: my(shape.y2),
            curve: shape.curve ? { x: shape.curve.x, y: my(shape.curve.y) } : undefined,
          };
    case "freehand":
      return {
        ...shape,
        points: shape.points.map((p) => (axis === "h" ? { x: mx(p.x), y: p.y } : { x: p.x, y: my(p.y) })),
      };
  }
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

/** Angle in degrees from a shape's center to `point`, measured so that
 * straight up reads as 0 -- what the rotate handle's resting position is. */
export function rotationTowards(shape: Shape, point: ImgPoint): number {
  const c = rotationCenter(shape);
  const degrees = (Math.atan2(point.y - c.y, point.x - c.x) * 180) / Math.PI + 90;
  // Normalize into [0, 360) so the value shown in the panel never drifts
  // into negatives or past a full turn.
  return ((degrees % 360) + 360) % 360;
}

export function resizeShape(shape: Shape, handle: HandleId, point: ImgPoint, keepAspect: boolean): Shape {
  if (handle === "rotate") {
    if (!isRotatable(shape)) return shape;
    const raw = rotationTowards(shape, point);
    // Shift snaps to 15-degree steps -- fine enough for a deliberate tilt,
    // coarse enough to land exactly on the right angles.
    const rotation = keepAspect ? Math.round(raw / 15) * 15 : Math.round(raw);
    return { ...shape, rotation: rotation % 360 };
  }

  // Dragging the mid handle bends the shaft by placing the quadratic control
  // point. It sits at twice the offset from the straight midpoint, because a
  // quadratic curve only reaches halfway to its control point -- without the
  // doubling the curve would lag visibly behind the cursor.
  if (shape.kind === "arrow" && handle === "mid") {
    const midX = (shape.x1 + shape.x2) / 2;
    const midY = (shape.y1 + shape.y2) / 2;
    return { ...shape, curve: { x: midX + (point.x - midX) * 2, y: midY + (point.y - midY) * 2 } };
  }

  // Centered shapes resize by their bounding box like anything else, but the
  // result is written back as center + size, so dragging a corner grows them
  // about their own middle instead of walking the center across the image.
  if ((shape.kind === "stamp" || shape.kind === "loupe") && handle !== "start" && handle !== "end" && handle !== "mid") {
    const next = resizeBounds(shapeBounds(shape), handle, toLocalPoint(point, shape), keepAspect);
    const cx = next.x + next.w / 2;
    const cy = next.y + next.h / 2;
    const extent = Math.max(next.w, next.h);
    return shape.kind === "stamp"
      ? { ...shape, x: cx, y: cy, size: Math.max(8, extent) }
      : { ...shape, x: cx, y: cy, r: Math.max(8, extent / 2) };
  }

  if (isEndpointLike(shape) && (handle === "start" || handle === "end")) {
    const fixed = handle === "start" ? { x: shape.x2, y: shape.y2 } : { x: shape.x1, y: shape.y1 };
    const moved = keepAspect ? snapAngle(fixed, point) : point;
    return handle === "start"
      ? { ...shape, x1: moved.x, y1: moved.y }
      : { ...shape, x2: moved.x, y2: moved.y };
  }

  if (!isRectLike(shape) || handle === "start" || handle === "end" || handle === "mid") return shape;

  const orig = shapeBounds(shape);
  // A rotated shape resizes in its own frame: the pointer is mapped back
  // through the rotation first, so dragging the "e" handle still widens the
  // shape along its own axis rather than along the image's.
  const next = resizeBounds(orig, handle, toLocalPoint(point, shape), keepAspect);

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
