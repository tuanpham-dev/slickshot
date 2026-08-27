import { describe, expect, it } from "vitest";
import { snapAngle, squareFromDrag } from "./constrain";

describe("squareFromDrag", () => {
  it("uses the larger of the two axis deltas as the side length", () => {
    expect(squareFromDrag({ x: 0, y: 0 }, { x: 30, y: 10 })).toEqual({ x: 30, y: 30 });
  });

  it("preserves the drag direction on both axes", () => {
    expect(squareFromDrag({ x: 0, y: 0 }, { x: -30, y: -10 })).toEqual({ x: -30, y: -30 });
    expect(squareFromDrag({ x: 0, y: 0 }, { x: -10, y: 30 })).toEqual({ x: -30, y: 30 });
  });

  it("defaults to the positive direction when a delta is exactly zero (Math.sign(0) is 0)", () => {
    // dx = 0: Math.sign(dx || 1) falls back to Math.sign(1) = 1, so the
    // square still grows instead of collapsing to a zero-width line.
    expect(squareFromDrag({ x: 0, y: 0 }, { x: 0, y: 20 })).toEqual({ x: 20, y: 20 });
  });

  it("returns a zero-size square for a zero-delta drag", () => {
    expect(squareFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe("snapAngle", () => {
  const anchor = { x: 0, y: 0 };

  it("returns the point unchanged when it coincides with the anchor (zero distance)", () => {
    expect(snapAngle(anchor, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("snaps a near-horizontal drag flat to 0°", () => {
    const result = snapAngle(anchor, { x: 100, y: 5 });
    expect(result.y).toBeCloseTo(0, 5);
    expect(result.x).toBeCloseTo(100.12, 1);
  });

  it("snaps a near-vertical drag to 90°", () => {
    const result = snapAngle(anchor, { x: 5, y: 100 });
    expect(result.x).toBeCloseTo(0, 5);
    expect(result.y).toBeGreaterThan(0);
  });

  it("snaps a diagonal drag to exactly 45°", () => {
    const result = snapAngle(anchor, { x: 50, y: 50 });
    expect(result.x).toBeCloseTo(result.y, 5);
  });

  it("preserves the drag distance exactly, only the angle changes", () => {
    const point = { x: 37, y: 61 };
    const dist = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    const result = snapAngle(anchor, point);
    const resultDist = Math.hypot(result.x - anchor.x, result.y - anchor.y);
    expect(resultDist).toBeCloseTo(dist, 5);
  });

  it("works from a non-origin anchor", () => {
    const shiftedAnchor = { x: 20, y: 20 };
    const result = snapAngle(shiftedAnchor, { x: 120, y: 21 });
    expect(result.y).toBeCloseTo(20, 5);
  });
});
