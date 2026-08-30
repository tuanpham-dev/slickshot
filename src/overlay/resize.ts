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

/** Selection aspect lock. `null` is freeform; the others are width:height. */
export type AspectId = null | "1:1" | "4:3" | "16:9" | "9:16";

export const ASPECT_OPTIONS: { id: AspectId; label: string }[] = [
  { id: null, label: "Free" },
  { id: "1:1", label: "1:1" },
  { id: "4:3", label: "4:3" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
];

const ASPECT_RATIOS: Record<Exclude<AspectId, null>, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

export function aspectRatio(aspect: AspectId): number | null {
  return aspect === null ? null : ASPECT_RATIOS[aspect];
}

/** Forces `rect` to `aspect` while keeping the corner opposite the one being
 * dragged pinned. `anchor` is that fixed corner; passing the drag's origin
 * point covers drag-create (where the anchor is where the press landed).
 *
 * The larger of the two candidate dimensions wins so the rect tracks the
 * pointer on whichever axis the user is moving furthest -- constraining to
 * the smaller one instead makes a fast diagonal drag feel like it's lagging. */
export function constrainToAspect(rect: PhysRect, aspect: AspectId, anchor: PhysPoint): PhysRect {
  const ratio = aspectRatio(aspect);
  if (ratio === null) return rect;

  const fromWidth = Math.abs(rect.w);
  const fromHeight = Math.abs(rect.h) * ratio;
  const w = Math.max(1, Math.round(Math.max(fromWidth, fromHeight)));
  const h = Math.max(1, Math.round(w / ratio));

  // Grow away from the anchor along whichever side of it the rect currently
  // sits, so dragging up-left keeps extending up-left.
  const growsRight = anchor.x <= rect.x + rect.w / 2;
  const growsDown = anchor.y <= rect.y + rect.h / 2;
  return {
    x: growsRight ? anchor.x : anchor.x - w,
    y: growsDown ? anchor.y : anchor.y - h,
    w,
    h,
  };
}

/** A guide line the overlay draws when an edge snaps. */
export interface SnapGuide {
  axis: "x" | "y";
  position: number;
}

export interface SnapResult {
  rect: PhysRect;
  guides: SnapGuide[];
}

/** Pulls `rect`'s edges onto nearby window edges. Each axis snaps to at most
 * one candidate (the nearest within `threshold`), and only the edge that is
 * actually closer to a candidate moves -- so resizing from the east handle
 * can't silently drag the west edge along with it.
 *
 * `moving` names which edges the current gesture is allowed to move: a
 * handle drag moves only its own edges, while a drag-create moves the two
 * edges away from the anchor. Callers that move the whole rect (a body drag)
 * pass all four and get the rect translated, not resized. */
export function snapRectToEdges(
  rect: PhysRect,
  candidates: PhysRect[],
  threshold: number,
  moving: { left: boolean; right: boolean; top: boolean; bottom: boolean } = {
    left: true,
    right: true,
    top: true,
    bottom: true,
  },
): SnapResult {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of candidates) {
    xs.push(c.x, c.x + c.w);
    ys.push(c.y, c.y + c.h);
  }

  const guides: SnapGuide[] = [];
  let { x, y, w, h } = rect;

  const nearest = (value: number, pool: number[]): number | null => {
    let best: { v: number; d: number } | null = null;
    for (const candidate of pool) {
      const d = Math.abs(candidate - value);
      if (d <= threshold && (!best || d < best.d)) best = { v: candidate, d };
    }
    return best?.v ?? null;
  };

  const left = nearest(x, xs);
  const right = nearest(x + w, xs);
  // Whichever edge is closer to a candidate wins the axis, so a narrow rect
  // between two windows doesn't get pulled from both sides at once.
  const leftDist = left === null ? Infinity : Math.abs(left - x);
  const rightDist = right === null ? Infinity : Math.abs(right - (x + w));
  if (moving.left && left !== null && leftDist <= rightDist) {
    w = Math.max(1, w + (x - left));
    x = left;
    guides.push({ axis: "x", position: left });
  } else if (moving.right && right !== null) {
    w = Math.max(1, right - x);
    guides.push({ axis: "x", position: x + w });
  }

  const top = nearest(y, ys);
  const bottom = nearest(y + h, ys);
  const topDist = top === null ? Infinity : Math.abs(top - y);
  const bottomDist = bottom === null ? Infinity : Math.abs(bottom - (y + h));
  if (moving.top && top !== null && topDist <= bottomDist) {
    h = Math.max(1, h + (y - top));
    y = top;
    guides.push({ axis: "y", position: top });
  } else if (moving.bottom && bottom !== null) {
    h = Math.max(1, bottom - y);
    guides.push({ axis: "y", position: y + h });
  }

  return { rect: { x, y, w, h }, guides };
}
