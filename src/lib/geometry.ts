export interface PhysPoint {
  x: number;
  y: number;
}

export interface PhysRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectFromPoints(a: PhysPoint, b: PhysPoint): PhysRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.max(Math.abs(a.x - b.x), 1);
  const h = Math.max(Math.abs(a.y - b.y), 1);
  return { x, y, w, h };
}

export function rectContains(r: PhysRect, p: PhysPoint): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

export function rectIntersect(a: PhysRect, b: PhysRect): PhysRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/** Which of `monitors` a selection lives on: every monitor it overlaps, and
 * the one holding the largest share of it. With one overlay window per
 * monitor, the owner is the single window that draws the selection's chrome
 * (size readout, confirm/cancel) -- otherwise a region straddling a seam got
 * a set on each side. */
export function selectionMonitors<M extends { id: number; rect: PhysRect }>(
  selection: PhysRect,
  monitors: readonly M[],
): { owner: M | null; overlapping: M[] } {
  let owner: M | null = null;
  let best = 0;
  const overlapping: M[] = [];
  for (const m of monitors) {
    const part = rectIntersect(selection, m.rect);
    if (!part) continue;
    overlapping.push(m);
    const area = part.w * part.h;
    if (area > best) {
      best = area;
      owner = m;
    }
  }
  return { owner, overlapping };
}
