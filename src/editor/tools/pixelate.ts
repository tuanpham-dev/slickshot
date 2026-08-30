import type { ImgPoint, PixelateShape, Style } from "../types";

export function createPixelate(id: string, start: ImgPoint, current: ImgPoint, style: Style): PixelateShape {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    id,
    kind: "pixelate",
    x,
    y,
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
    blockSize: style.pixelateBlock,
    mode: style.censorMode,
    color: style.censorColor,
  };
}
