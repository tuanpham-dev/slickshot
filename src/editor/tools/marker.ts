import type { ImgPoint, MarkerShape, Shape, Style } from "../types";

/** Restores the invariant that markers read 1..n in insertion (shapes-array)
 * order. Run after any add/remove so deleting marker 2 of 3 leaves 1,2 rather
 * than a gap at 2 -- the numbers are a display of sequence, not identity, so
 * they're derived from position instead of stored from a counter.
 *
 * Markers whose number is already correct pass through by reference, so an
 * edit that doesn't disturb numbering allocates nothing. */
export function renumberMarkers(shapes: Shape[]): Shape[] {
  let n = 0;
  return shapes.map((s) => {
    if (s.kind !== "marker") return s;
    n += 1;
    return s.number === n ? s : { ...s, number: n };
  });
}

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
