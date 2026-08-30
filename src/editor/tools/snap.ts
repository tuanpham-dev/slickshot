export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A guide line drawn while a drag is snapped, in image space. */
export interface AlignGuide {
  axis: "x" | "y";
  position: number;
}

export interface SnapDragResult {
  dx: number;
  dy: number;
  guides: AlignGuide[];
}

/** The three positions on each axis a shape can align by. Edges catch
 * "line these up flush", the center catches "line these up symmetrically". */
function candidatesFor(b: Bounds, axis: "x" | "y"): number[] {
  return axis === "x" ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h];
}

/** Nudges a dragged shape onto alignment with the other shapes and with the
 * image itself, returning the offset to apply on top of the raw drag plus
 * the guides to draw.
 *
 * Each axis snaps at most once, to whichever pairing of the moving shape's
 * three positions and a candidate's three is closest within `threshold` --
 * so a shape can align left-to-left, center-to-center, or right-to-left
 * without the caller enumerating the combinations. */
export function snapShapeDrag(
  moving: Bounds,
  others: Bounds[],
  imageWidth: number,
  imageHeight: number,
  threshold: number,
): SnapDragResult {
  // The image's own edges and center are alignment targets too, expressed as
  // a bounds so they go through the same comparison as every other shape.
  const targets: Bounds[] = [...others, { x: 0, y: 0, w: imageWidth, h: imageHeight }];

  const bestFor = (axis: "x" | "y"): { delta: number; position: number } | null => {
    let best: { delta: number; position: number; dist: number } | null = null;
    for (const source of candidatesFor(moving, axis)) {
      for (const target of targets) {
        for (const candidate of candidatesFor(target, axis)) {
          const dist = Math.abs(candidate - source);
          if (dist > threshold) continue;
          if (!best || dist < best.dist) {
            best = { delta: candidate - source, position: candidate, dist };
          }
        }
      }
    }
    return best ? { delta: best.delta, position: best.position } : null;
  };

  const x = bestFor("x");
  const y = bestFor("y");
  const guides: AlignGuide[] = [];
  if (x) guides.push({ axis: "x", position: x.position });
  if (y) guides.push({ axis: "y", position: y.position });

  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides };
}
