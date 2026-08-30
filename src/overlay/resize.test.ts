import { describe, expect, it } from "vitest";
import {
  constrainToAspect,
  HANDLES,
  handlePhysPositions,
  pickHandle,
  resizeRect,
  snapRectToEdges,
} from "./resize";

describe("HANDLES", () => {
  it("declares exactly the 8 corner/edge handles", () => {
    expect(HANDLES.map((h) => h.id).sort()).toEqual(["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
  });
});

describe("handlePhysPositions", () => {
  it("maps each handle to its physical position on the rect", () => {
    const positions = handlePhysPositions({ x: 0, y: 0, w: 100, h: 50 });
    expect(positions.find((p) => p.id === "se")).toEqual({ id: "se", x: 100, y: 50 });
    expect(positions.find((p) => p.id === "n")).toEqual({ id: "n", x: 50, y: 0 });
  });
});

describe("pickHandle", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };

  it("returns null when the point is far from every handle", () => {
    expect(pickHandle(rect, { x: 50, y: 50 }, 10)).toBeNull();
  });

  it("returns the handle within tolerance", () => {
    expect(pickHandle(rect, { x: 2, y: 2 }, 10)).toBe("nw");
  });

  it("picks the nearer of two handles within tolerance", () => {
    // Near the midpoint between "nw" (0,0) and "n" (50,0), but closer to "n".
    expect(pickHandle(rect, { x: 40, y: 2 }, 60)).toBe("n");
  });
});

describe("resizeRect", () => {
  const orig = { x: 10, y: 10, w: 20, h: 20 };

  it("resizes from a corner anchored at the opposite corner", () => {
    expect(resizeRect(orig, "se", { x: 50, y: 50 })).toEqual({ x: 10, y: 10, w: 40, h: 40 });
  });

  it("flips the rect when dragged past the anchor instead of collapsing", () => {
    expect(resizeRect(orig, "nw", { x: 40, y: 40 })).toEqual({ x: 30, y: 30, w: 10, h: 10 });
  });

  it("clamps to a minimum size of 1x1", () => {
    const result = resizeRect(orig, "se", { x: 10, y: 10 });
    expect(result.w).toBe(1);
    expect(result.h).toBe(1);
  });

  it("only resizes the relevant axis for an edge handle", () => {
    expect(resizeRect(orig, "e", { x: 100, y: 999 })).toEqual({ x: 10, y: 10, w: 90, h: 20 });
    expect(resizeRect(orig, "n", { x: 999, y: 0 })).toEqual({ x: 10, y: 0, w: 20, h: 30 });
  });

  it("matches the editor's non-aspect-locked resizeBounds for the same input (shared anchor-point math)", async () => {
    const { resizeBounds } = await import("../editor/tools/select");
    const a = resizeRect(orig, "sw", { x: -20, y: 60 });
    const b = resizeBounds(orig, "sw", { x: -20, y: 60 }, false);
    expect(a).toEqual(b);
  });
});

describe("constrainToAspect", () => {
  it("leaves the rect untouched when freeform", () => {
    const rect = { x: 10, y: 20, w: 130, h: 45 };
    expect(constrainToAspect(rect, null, { x: 10, y: 20 })).toEqual(rect);
  });

  it("squares the rect for 1:1, keeping the anchor corner pinned", () => {
    const out = constrainToAspect({ x: 0, y: 0, w: 100, h: 40 }, "1:1", { x: 0, y: 0 });
    expect(out).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it("applies 16:9 and 9:16 as width:height", () => {
    const wide = constrainToAspect({ x: 0, y: 0, w: 160, h: 10 }, "16:9", { x: 0, y: 0 });
    expect(wide.w / wide.h).toBeCloseTo(16 / 9, 1);
    const tall = constrainToAspect({ x: 0, y: 0, w: 90, h: 10 }, "9:16", { x: 0, y: 0 });
    expect(tall.w / tall.h).toBeCloseTo(9 / 16, 1);
  });

  it("keeps 4:3 growing up-left when the anchor is the bottom-right corner", () => {
    // anchor at (200,200), rect drawn back toward the origin
    const out = constrainToAspect({ x: 100, y: 140, w: 100, h: 60 }, "4:3", { x: 200, y: 200 });
    expect(out.x + out.w).toBe(200);
    expect(out.y + out.h).toBe(200);
    expect(out.w / out.h).toBeCloseTo(4 / 3, 1);
  });

  it("tracks the axis the pointer moved furthest on", () => {
    // height (60 * 1 = 60) exceeds width (20), so the square takes the height
    const out = constrainToAspect({ x: 0, y: 0, w: 20, h: 60 }, "1:1", { x: 0, y: 0 });
    expect(out.w).toBe(60);
  });
});

describe("snapRectToEdges", () => {
  const windows = [{ x: 100, y: 100, w: 400, h: 300 }];

  it("snaps an edge that lands within the threshold", () => {
    const { rect, guides } = snapRectToEdges({ x: 103, y: 200, w: 50, h: 50 }, windows, 8);
    expect(rect.x).toBe(100);
    expect(guides).toContainEqual({ axis: "x", position: 100 });
  });

  it("leaves edges outside the threshold alone", () => {
    const { rect, guides } = snapRectToEdges({ x: 140, y: 200, w: 50, h: 50 }, windows, 8);
    expect(rect.x).toBe(140);
    expect(guides).toHaveLength(0);
  });

  it("snaps the right edge to a window's right edge", () => {
    const { rect } = snapRectToEdges({ x: 300, y: 200, w: 196, h: 50 }, windows, 8);
    expect(rect.x + rect.w).toBe(500);
  });

  it("moves only the closer edge on each axis", () => {
    // left edge is 2px from 100; right edge is 6px from 500 -- left wins,
    // and the right edge must stay exactly where it was
    const { rect } = snapRectToEdges({ x: 102, y: 200, w: 392, h: 50 }, windows, 8);
    expect(rect.x).toBe(100);
    expect(rect.x + rect.w).toBe(494);
  });

  it("respects the moving-edge mask so a handle drag can't move its anchor", () => {
    const moving = { left: false, right: true, top: false, bottom: true };
    const { rect } = snapRectToEdges({ x: 103, y: 200, w: 50, h: 50 }, windows, 8, moving);
    expect(rect.x).toBe(103);
  });

  it("snaps both axes independently", () => {
    const { rect, guides } = snapRectToEdges({ x: 103, y: 104, w: 50, h: 50 }, windows, 8);
    expect(rect.x).toBe(100);
    expect(rect.y).toBe(100);
    expect(guides).toHaveLength(2);
  });
});
