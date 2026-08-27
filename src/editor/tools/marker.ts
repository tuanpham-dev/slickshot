import type { ImgPoint, MarkerShape, Style } from "../types";

export function createMarker(id: string, point: ImgPoint, number: number, style: Style): MarkerShape {
  return {
    id,
    kind: "marker",
    x: point.x,
    y: point.y,
    number,
    color: style.stroke,
    radius: style.markerSize,
  };
}
