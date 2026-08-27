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
