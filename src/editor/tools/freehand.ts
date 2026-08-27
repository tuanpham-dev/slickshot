import type { FreehandShape, ImgPoint, Style } from "../types";

export function startFreehand(id: string, start: ImgPoint, style: Style): FreehandShape {
  return {
    id,
    kind: "freehand",
    points: [start],
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
  };
}

export function extendFreehand(shape: FreehandShape, point: ImgPoint): FreehandShape {
  return { ...shape, points: [...shape.points, point] };
}
