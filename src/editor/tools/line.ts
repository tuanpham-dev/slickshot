import type { ImgPoint, LineShape, Style } from "../types";
import { snapAngle } from "./constrain";

export function createLine(
  id: string,
  start: ImgPoint,
  current: ImgPoint,
  style: Style,
  constrain = false,
): LineShape {
  const end = constrain ? snapAngle(start, current) : current;
  return {
    id,
    kind: "line",
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}
