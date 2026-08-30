import { describe, expect, it } from "vitest";
import { snapShapeDrag } from "./snap";

const IMAGE_W = 1000;
const IMAGE_H = 800;

describe("snapShapeDrag", () => {
  it("returns no offset when nothing is within the threshold", () => {
    // Deliberately clear of the image's own edges and center (500, 400) as
    // well as the other shape -- those are snap targets too.
    const result = snapShapeDrag(
      { x: 620, y: 620, w: 50, h: 50 },
      [{ x: 100, y: 100, w: 50, h: 50 }],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("aligns a left edge to another shape's left edge", () => {
    const result = snapShapeDrag(
      { x: 104, y: 400, w: 50, h: 50 },
      [{ x: 100, y: 100, w: 50, h: 50 }],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    expect(result.dx).toBe(-4);
    expect(result.guides).toContainEqual({ axis: "x", position: 100 });
  });

  it("aligns centers, not just edges", () => {
    // moving center x = 300; target center x = 297 -- 3px away
    const result = snapShapeDrag(
      { x: 275, y: 400, w: 50, h: 50 },
      [{ x: 197, y: 100, w: 200, h: 50 }],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    expect(result.dx).toBe(-3);
  });

  it("snaps a left edge to another shape's right edge", () => {
    const result = snapShapeDrag(
      { x: 152, y: 400, w: 50, h: 50 },
      [{ x: 100, y: 100, w: 50, h: 50 }],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    expect(result.dx).toBe(-2);
    expect(result.guides).toContainEqual({ axis: "x", position: 150 });
  });

  it("snaps to the image edges with no other shapes present", () => {
    const result = snapShapeDrag({ x: 3, y: 400, w: 50, h: 50 }, [], IMAGE_W, IMAGE_H, 6);
    expect(result.dx).toBe(-3);
    expect(result.guides).toContainEqual({ axis: "x", position: 0 });
  });

  it("snaps to the image center", () => {
    // image center x = 500; moving center x = 497
    const result = snapShapeDrag({ x: 472, y: 400, w: 50, h: 50 }, [], IMAGE_W, IMAGE_H, 6);
    expect(result.dx).toBe(3);
    expect(result.guides).toContainEqual({ axis: "x", position: 500 });
  });

  it("snaps both axes independently in one drag", () => {
    const result = snapShapeDrag(
      { x: 104, y: 103, w: 50, h: 50 },
      [{ x: 100, y: 100, w: 50, h: 50 }],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    expect(result.dx).toBe(-4);
    expect(result.dy).toBe(-3);
    expect(result.guides).toHaveLength(2);
  });

  it("picks the nearest candidate when several are in range", () => {
    const result = snapShapeDrag(
      { x: 102, y: 400, w: 50, h: 50 },
      [
        { x: 100, y: 100, w: 50, h: 50 },
        { x: 105, y: 200, w: 50, h: 50 },
      ],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    // 100 is 2px away, 105 is 3px -- the closer one wins.
    expect(result.dx).toBe(-2);
  });

  it("emits at most one guide per axis", () => {
    const result = snapShapeDrag(
      { x: 100, y: 100, w: 50, h: 50 },
      [
        { x: 100, y: 100, w: 50, h: 50 },
        { x: 101, y: 101, w: 50, h: 50 },
      ],
      IMAGE_W,
      IMAGE_H,
      6,
    );
    expect(result.guides.filter((g) => g.axis === "x")).toHaveLength(1);
    expect(result.guides.filter((g) => g.axis === "y")).toHaveLength(1);
  });
});
