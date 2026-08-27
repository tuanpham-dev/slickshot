import { describe, expect, it } from "vitest";
import type { ArrowShape, RectShape } from "../types";
import { cloneShape, moveShape, pickHandle, pickShape, resizeBounds, resizeShape } from "./select";

const rect: RectShape = { id: "1", kind: "rect", x: 10, y: 10, w: 20, h: 20, stroke: "#000", fill: null, strokeWidth: 2 };

describe("pickShape", () => {
  it("returns null when nothing is hit", () => {
    expect(pickShape([rect], { x: 500, y: 500 })).toBeNull();
  });

  it("picks the topmost (last-drawn) shape when two overlap", () => {
    const bottom: RectShape = { ...rect, id: "bottom" };
    const top: RectShape = { ...rect, id: "top" };
    expect(pickShape([bottom, top], { x: 15, y: 15 })?.id).toBe("top");
  });
});

describe("moveShape", () => {
  it("offsets a rect-like shape's x/y", () => {
    expect(moveShape(rect, 5, -5)).toMatchObject({ x: 15, y: 5 });
  });

  it("offsets both endpoints of an arrow", () => {
    const arrow: ArrowShape = { id: "a", kind: "arrow", x1: 0, y1: 0, x2: 10, y2: 10, stroke: "#000", strokeWidth: 1 };
    expect(moveShape(arrow, 5, 5)).toMatchObject({ x1: 5, y1: 5, x2: 15, y2: 15 });
  });

  it("offsets every point of a freehand path", () => {
    const freehand = {
      id: "f",
      kind: "freehand" as const,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      stroke: "#000",
      strokeWidth: 1,
    };
    const result = moveShape(freehand, 2, 3);
    if (result.kind !== "freehand") throw new Error("expected freehand");
    expect(result.points).toEqual([{ x: 2, y: 3 }, { x: 12, y: 13 }]);
  });

  it("is a no-op offset (dx=0, dy=0) that still returns an equal-valued shape", () => {
    expect(moveShape(rect, 0, 0)).toEqual(rect);
  });
});

describe("cloneShape", () => {
  it("gives the clone a different id from the original", () => {
    expect(cloneShape(rect).id).not.toBe(rect.id);
  });

  it("defaults to no offset", () => {
    expect(cloneShape(rect)).toMatchObject({ x: rect.x, y: rect.y });
  });

  it("applies the requested offset", () => {
    expect(cloneShape(rect, 100, 200)).toMatchObject({ x: 110, y: 210 });
  });
});

describe("pickHandle", () => {
  const handles = [
    { id: "nw" as const, x: 0, y: 0 },
    { id: "se" as const, x: 100, y: 100 },
  ];

  it("returns null when no handle is within the pad", () => {
    expect(pickHandle(handles, { x: 50, y: 50 }, 5)).toBeNull();
  });

  it("returns the nearest handle within the pad", () => {
    expect(pickHandle(handles, { x: 2, y: 2 }, 5)).toBe("nw");
  });

  it("prefers the closer handle when two are within pad range", () => {
    const close = [
      { id: "nw" as const, x: 0, y: 0 },
      { id: "se" as const, x: 8, y: 8 },
    ];
    // Point is 6px from "se" and ~8.5px from "nw" -- within a generous pad
    // of both, must still pick the nearer one.
    expect(pickHandle(close, { x: 6, y: 6 }, 20)).toBe("se");
  });
});

describe("resizeBounds", () => {
  const orig = { x: 10, y: 10, w: 20, h: 20 };

  it("resizes from a corner, anchored at the opposite corner", () => {
    // Dragging "se" out to (50, 50): "nw" (10,10) stays fixed.
    expect(resizeBounds(orig, "se", { x: 50, y: 50 }, false)).toEqual({ x: 10, y: 10, w: 40, h: 40 });
  });

  it("flips the box when the corner is dragged past its anchor", () => {
    // Dragging "se" up-left past "nw" (10,10) to (0,0): the box now sits
    // above/left of the anchor instead of collapsing to nothing.
    const result = resizeBounds(orig, "se", { x: 0, y: 0 }, false);
    expect(result).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it("clamps width/height to a minimum of 1 rather than 0 when dragged onto the anchor", () => {
    const result = resizeBounds(orig, "se", { x: 10, y: 10 }, false);
    expect(result.w).toBe(1);
    expect(result.h).toBe(1);
  });

  it("only moves the y-axis edge for a top/bottom edge handle", () => {
    const result = resizeBounds(orig, "s", { x: 999, y: 40 }, false);
    expect(result).toEqual({ x: 10, y: 10, w: 20, h: 30 });
  });

  it("only moves the x-axis edge for a left/right edge handle", () => {
    const result = resizeBounds(orig, "e", { x: 60, y: 999 }, false);
    expect(result).toEqual({ x: 10, y: 10, w: 50, h: 20 });
  });

  it("preserves aspect ratio from a corner when keepAspect is true", () => {
    const wide = { x: 0, y: 0, w: 40, h: 20 }; // aspect 2:1
    // Drag far enough that width would dominate; height must follow to keep 2:1.
    const result = resizeBounds(wide, "se", { x: 100, y: 60 }, true);
    expect(result.w / result.h).toBeCloseTo(2, 5);
  });

  it("falls back to aspect 1 instead of dividing by zero for a zero-height original", () => {
    const flat = { x: 0, y: 0, w: 40, h: 0 };
    expect(() => resizeBounds(flat, "se", { x: 80, y: 40 }, true)).not.toThrow();
    const result = resizeBounds(flat, "se", { x: 80, y: 40 }, true);
    expect(Number.isFinite(result.w)).toBe(true);
    expect(Number.isFinite(result.h)).toBe(true);
  });
});

describe("resizeShape", () => {
  it("resizes a rect-like shape via its bounding box", () => {
    const result = resizeShape(rect, "se", { x: 40, y: 40 }, false);
    expect(result).toMatchObject({ x: 10, y: 10, w: 30, h: 30 });
  });

  it("moves one endpoint of an arrow, leaving the other fixed", () => {
    const arrow: ArrowShape = { id: "a", kind: "arrow", x1: 0, y1: 0, x2: 10, y2: 10, stroke: "#000", strokeWidth: 1 };
    const result = resizeShape(arrow, "end", { x: 50, y: 5 }, false);
    expect(result).toMatchObject({ x1: 0, y1: 0, x2: 50, y2: 5 });
  });

  it("snaps an endpoint drag to 45° increments when keepAspect (shift) is held", () => {
    const arrow: ArrowShape = { id: "a", kind: "arrow", x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#000", strokeWidth: 1 };
    // Dragging "end" to a shallow near-horizontal angle should snap flat (y2 stays 0).
    const result = resizeShape(arrow, "end", { x: 10, y: 1 }, true) as ArrowShape;
    expect(result.y2).toBe(0);
  });

  it("rescales every point of a freehand shape proportionally", () => {
    const freehand = {
      id: "f",
      kind: "freehand" as const,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      stroke: "#000",
      strokeWidth: 1,
    };
    const result = resizeShape(freehand, "se", { x: 20, y: 20 }, false);
    expect(result.kind).toBe("freehand");
    if (result.kind === "freehand") {
      expect(result.points).toEqual([{ x: 0, y: 0 }, { x: 20, y: 20 }]);
    }
  });

  it("is a no-op for a shape kind with no handles (text)", () => {
    const text = { id: "t", kind: "text" as const, x: 0, y: 0, text: "hi", color: "#000", fontSize: 10, background: false };
    expect(resizeShape(text, "se", { x: 100, y: 100 }, false)).toEqual(text);
  });
});
