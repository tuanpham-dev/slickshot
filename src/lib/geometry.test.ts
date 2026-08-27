import { describe, expect, it } from "vitest";
import { rectContains, rectFromPoints, rectIntersect } from "./geometry";

describe("rectFromPoints", () => {
  it("normalizes a rect dragged from bottom-right to top-left", () => {
    expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 20 });
  });

  it("normalizes a rect dragged top-left to bottom-right", () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 50, y: 40 })).toEqual({ x: 10, y: 20, w: 40, h: 20 });
  });

  it("clamps a zero-size drag (both points identical) to a 1x1 rect instead of vanishing", () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 1, h: 1 });
  });

  it("handles negative coordinates", () => {
    expect(rectFromPoints({ x: -10, y: -10 }, { x: -30, y: 5 })).toEqual({ x: -30, y: -10, w: 20, h: 15 });
  });
});

describe("rectContains", () => {
  const r = { x: 10, y: 10, w: 20, h: 20 };

  it("is true for a point inside", () => {
    expect(rectContains(r, { x: 15, y: 15 })).toBe(true);
  });

  it("is true on the top/left edge (inclusive)", () => {
    expect(rectContains(r, { x: 10, y: 10 })).toBe(true);
  });

  it("is false on the bottom/right edge (exclusive, half-open interval)", () => {
    expect(rectContains(r, { x: 30, y: 20 })).toBe(false);
    expect(rectContains(r, { x: 20, y: 30 })).toBe(false);
  });

  it("is false outside the rect", () => {
    expect(rectContains(r, { x: 0, y: 0 })).toBe(false);
    expect(rectContains(r, { x: 31, y: 15 })).toBe(false);
  });
});

describe("rectIntersect", () => {
  it("returns the overlapping area for two overlapping rects", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(rectIntersect(a, b)).toEqual({ x: 5, y: 5, w: 5, h: 5 });
  });

  it("returns null for disjoint rects", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 20, y: 20, w: 10, h: 10 };
    expect(rectIntersect(a, b)).toBeNull();
  });

  it("returns null for rects that only touch at an edge (zero-area overlap)", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 10, y: 0, w: 10, h: 10 };
    expect(rectIntersect(a, b)).toBeNull();
  });

  it("returns the smaller rect when one fully contains the other", () => {
    const outer = { x: 0, y: 0, w: 100, h: 100 };
    const inner = { x: 10, y: 10, w: 5, h: 5 };
    expect(rectIntersect(outer, inner)).toEqual(inner);
  });

  it("is symmetric", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(rectIntersect(a, b)).toEqual(rectIntersect(b, a));
  });
});
