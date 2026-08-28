import type { ImgPoint, RectShape, Style } from "../types";
import { squareFromDrag } from "./constrain";

export function createRect(
  id: string,
  start: ImgPoint,
  current: ImgPoint,
  style: Style,
  constrain = false,
): RectShape {
  const c = constrain ? squareFromDrag(start, current) : current;
  const x = Math.min(start.x, c.x);
  const y = Math.min(start.y, c.y);
  return {
    id,
    kind: "rect",
    x,
    y,
    w: Math.abs(c.x - start.x),
    h: Math.abs(c.y - start.y),
    stroke: style.stroke,
    fill: style.fill,
    strokeWidth: style.strokeWidth,
    radius: style.radius,
  };
}
