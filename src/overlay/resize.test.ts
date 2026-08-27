import { describe, expect, it } from "vitest";
import { HANDLES, handlePhysPositions, pickHandle, resizeRect } from "./resize";

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
