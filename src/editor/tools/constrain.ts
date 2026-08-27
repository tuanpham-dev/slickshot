import type { ImgPoint } from "../types";

/** Projects `current` so the drag from `start` forms a square, preserving direction. */
export function squareFromDrag(start: ImgPoint, current: ImgPoint): ImgPoint {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + Math.sign(dx || 1) * side,
    y: start.y + Math.sign(dy || 1) * side,
  };
}

/** Snaps the angle from `anchor` to `point` to the nearest 45° increment. */
export function snapAngle(anchor: ImgPoint, point: ImgPoint): ImgPoint {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return point;
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  return {
    x: anchor.x + Math.cos(snapped) * dist,
    y: anchor.y + Math.sin(snapped) * dist,
  };
}
