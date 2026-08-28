import type { ImgPoint, SpotlightShape, Style } from "../types";

export function createSpotlight(id: string, start: ImgPoint, current: ImgPoint, style: Style): SpotlightShape {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    id,
    kind: "spotlight",
    x,
    y,
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
    dimOpacity: style.spotlightDim,
    form: style.spotlightForm,
    radius: style.radius,
  };
}
