import type { PhysPoint, PhysRect } from "../lib/geometry";

/** Pulled out of `Overlay.tsx` (a component file) so this pure geometry is
 * unit-testable and doesn't trip React Fast Refresh -- exporting a non-
 * component constant/function from a component module forces Vite to fall
 * back to a full reload instead of hot-patching it. */
export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: { id: HandleId; xFrac: number; yFrac: number; cursor: string }[] = [
  { id: "nw", xFrac: 0, yFrac: 0, cursor: "nwse-resize" },
  { id: "n", xFrac: 0.5, yFrac: 0, cursor: "ns-resize" },
  { id: "ne", xFrac: 1, yFrac: 0, cursor: "nesw-resize" },
  { id: "e", xFrac: 1, yFrac: 0.5, cursor: "ew-resize" },
  { id: "se", xFrac: 1, yFrac: 1, cursor: "nwse-resize" },
  { id: "s", xFrac: 0.5, yFrac: 1, cursor: "ns-resize" },
  { id: "sw", xFrac: 0, yFrac: 1, cursor: "nesw-resize" },
  { id: "w", xFrac: 0, yFrac: 0.5, cursor: "ew-resize" },
];

export function handlePhysPositions(rect: PhysRect): { id: HandleId; x: number; y: number }[] {
  return HANDLES.map(({ id, xFrac, yFrac }) => ({
    id,
    x: rect.x + rect.w * xFrac,
    y: rect.y + rect.h * yFrac,
  }));
}

export function pickHandle(rect: PhysRect, p: PhysPoint, tolPhys: number): HandleId | null {
  let best: { id: HandleId; dist: number } | null = null;
  for (const h of handlePhysPositions(rect)) {
    const dist = Math.hypot(h.x - p.x, h.y - p.y);
    if (dist <= tolPhys && (!best || dist < best.dist)) best = { id: h.id, dist };
  }
  return best?.id ?? null;
}

/** Resizes `orig` from the opposite anchor corner/edge, same anchor-point
 * math as the editor's shape resize (`editor/tools/select.ts`). */
export function resizeRect(orig: PhysRect, handle: HandleId, point: PhysPoint): PhysRect {
  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;
  const isCorner = handle === "nw" || handle === "ne" || handle === "se" || handle === "sw";

  if (isCorner) {
    const anchorX = handle === "nw" || handle === "sw" ? right : orig.x;
    const anchorY = handle === "nw" || handle === "ne" ? bottom : orig.y;
    const newW = Math.max(1, Math.abs(point.x - anchorX));
    const newH = Math.max(1, Math.abs(point.y - anchorY));
    const signX = point.x < anchorX ? -1 : 1;
    const signY = point.y < anchorY ? -1 : 1;
    const cornerX = anchorX + signX * newW;
    const cornerY = anchorY + signY * newH;
    return { x: Math.min(anchorX, cornerX), y: Math.min(anchorY, cornerY), w: newW, h: newH };
  }

  if (handle === "n" || handle === "s") {
    const anchorY = handle === "n" ? bottom : orig.y;
    const newH = Math.max(1, Math.abs(point.y - anchorY));
    return { x: orig.x, y: Math.min(anchorY, point.y), w: orig.w, h: newH };
  }

  // "e" | "w"
  const anchorX = handle === "w" ? right : orig.x;
  const newW = Math.max(1, Math.abs(point.x - anchorX));
  return { x: Math.min(anchorX, point.x), y: orig.y, w: newW, h: orig.h };
}
