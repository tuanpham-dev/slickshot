import type { ImgPoint, LoupeShape, Style } from "../types";

/** Drag-creates a loupe: the press point is the center, the drag distance is
 * the radius, so it grows symmetrically from where the gesture started
 * (unlike the rect tools, which grow from a corner). */
export function createLoupe(id: string, start: ImgPoint, current: ImgPoint, style: Style): LoupeShape {
  const r = Math.max(8, Math.round(Math.hypot(current.x - start.x, current.y - start.y)));
  return {
    id,
    kind: "loupe",
    x: start.x,
    y: start.y,
    r,
    factor: style.loupeFactor,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}
