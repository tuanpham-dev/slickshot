import type { ArrowShape, ImgPoint, Style } from "../types";
import { snapAngle } from "./constrain";

export function createArrow(
  id: string,
  start: ImgPoint,
  current: ImgPoint,
  style: Style,
  constrain = false,
): ArrowShape {
  const end = constrain ? snapAngle(start, current) : current;
  return {
    id,
    kind: "arrow",
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}
