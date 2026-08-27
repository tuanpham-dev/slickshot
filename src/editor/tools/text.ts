import type { ImgPoint, TextShape } from "../types";

export function createText(id: string, point: ImgPoint, text: string, color: string, fontSize: number): TextShape {
  return {
    id,
    kind: "text",
    x: point.x,
    y: point.y,
    text,
    color,
    fontSize,
    background: false,
  };
}
