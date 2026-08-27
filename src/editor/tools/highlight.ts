import type { HighlightShape, ImgPoint, Style } from "../types";

export function createHighlight(id: string, start: ImgPoint, current: ImgPoint, style: Style): HighlightShape {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    id,
    kind: "highlight",
    x,
    y,
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
    color: style.stroke,
  };
}
