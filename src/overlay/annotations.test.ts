import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { rebaseToRegion, shapesForMonitor, useAnnotations } from "./annotations";
import type { Shape } from "../editor/types";

function rect(x: number, y: number, id = "r"): Shape {
  return { id, kind: "rect", x, y, w: 40, h: 30, stroke: "#000", fill: null, strokeWidth: 2 };
}

/** Narrows past the `Shape` union so a test can tweak a rect's stroke. */
function recolored(shape: Shape, stroke: string): Shape {
  return shape.kind === "rect" ? { ...shape, stroke } : shape;
}

function arrow(x1: number, y1: number, x2: number, y2: number): Shape {
  return { id: "a", kind: "arrow", x1, y1, x2, y2, stroke: "#000", strokeWidth: 2 };
}

describe("rebaseToRegion", () => {
  it("puts the region's top-left at the image origin", () => {
    const [out] = rebaseToRegion([rect(120, 90)], { x: 100, y: 50, w: 300, h: 200 });
    expect(out).toMatchObject({ x: 20, y: 40 });
  });

  it("handles a region on a monitor at a negative origin", () => {
    // A display arranged to the left of the primary has negative x.
    const [out] = rebaseToRegion([rect(-380, 90)], { x: -400, y: 50, w: 300, h: 200 });
    expect(out).toMatchObject({ x: 20, y: 40 });
  });

  it("moves every coordinate of a multi-point shape", () => {
    const [out] = rebaseToRegion([arrow(120, 90, 200, 150)], { x: 100, y: 50, w: 300, h: 200 });
    expect(out).toMatchObject({ x1: 20, y1: 40, x2: 100, y2: 100 });
  });

  it("leaves shapes untouched for a region at the origin", () => {
    const input = [rect(10, 20)];
    expect(rebaseToRegion(input, { x: 0, y: 0, w: 100, h: 100 })).toMatchObject([{ x: 10, y: 20 }]);
  });

  it("does not mutate its input", () => {
    const input = [rect(120, 90)];
    rebaseToRegion(input, { x: 100, y: 50, w: 300, h: 200 });
    expect(input[0]).toMatchObject({ x: 120, y: 90 });
  });
});

describe("shapesForMonitor", () => {
  it("translates into the monitor's own canvas space", () => {
    const [out] = shapesForMonitor([rect(2100, 400)], { x: 1920, y: 0, w: 1920, h: 1080 });
    expect(out).toMatchObject({ x: 180, y: 400 });
  });

  it("is the identity for the monitor at the virtual origin", () => {
    const [out] = shapesForMonitor([rect(10, 20)], { x: 0, y: 0, w: 1920, h: 1080 });
    expect(out).toMatchObject({ x: 10, y: 20 });
  });

  it("can place a shape off-canvas, which the canvas simply clips", () => {
    // A shape drawn on the left monitor, viewed from the right one.
    const [out] = shapesForMonitor([rect(100, 100)], { x: 1920, y: 0, w: 1920, h: 1080 });
    expect(out).toMatchObject({ x: -1820 });
  });
});

describe("useAnnotations", () => {
  it("starts empty and cannot undo", () => {
    const { result } = renderHook(() => useAnnotations());
    expect(result.current.shapes).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });

  it("commits shapes in order and clears the draft", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.setDraft(rect(0, 0, "draft")));
    act(() => void result.current.commit(rect(1, 1, "a")));
    expect(result.current.draft).toBeNull();
    act(() => void result.current.commit(rect(2, 2, "b")));
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("undo restores the previous list", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.commit(rect(2, 2, "b")));
    act(() => void result.current.undo());
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a"]);
    act(() => void result.current.undo());
    expect(result.current.shapes).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });

  it("undo is a no-op on an empty history", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.undo());
    expect(result.current.shapes).toEqual([]);
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.undo());
    act(() => void result.current.undo());
    expect(result.current.shapes).toEqual([]);
  });

  it("returns the resulting list from commit and undo, for broadcasting", () => {
    // The caller broadcasts the new list immediately; reading `shapes` right
    // after would still see the pre-update render.
    const { result } = renderHook(() => useAnnotations());
    let committed: Shape[] = [];
    act(() => {
      committed = result.current.commit(rect(1, 1, "a"));
    });
    expect(committed.map((s) => s.id)).toEqual(["a"]);
    let undone: Shape[] = [rect(0, 0)];
    act(() => {
      undone = result.current.undo();
    });
    expect(undone).toEqual([]);
  });

  it("replace does not add an undo step", () => {
    // Shapes arriving from another monitor's overlay belong to that window's
    // history, not this one's.
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.replace([rect(1, 1, "remote")]));
    expect(result.current.shapes.map((s) => s.id)).toEqual(["remote"]);
    expect(result.current.canUndo).toBe(false);
  });

  it("redo replays what undo took back", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.commit(rect(2, 2, "b")));
    act(() => void result.current.undo());
    expect(result.current.canRedo).toBe(true);
    act(() => void result.current.redo());
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(result.current.canRedo).toBe(false);
  });

  it("redo is a no-op with nothing undone", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.redo());
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a"]);
  });

  it("a new edit after undoing drops the redo branch", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.undo());
    act(() => void result.current.commit(rect(3, 3, "c")));
    expect(result.current.canRedo).toBe(false);
    act(() => void result.current.redo());
    expect(result.current.shapes.map((s) => s.id)).toEqual(["c"]);
  });

  it("update replaces one shape in place and is undoable", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.commit(rect(2, 2, "b")));
    act(() => void result.current.update(recolored(rect(9, 9, "a"), "#f00")));
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(result.current.shapes[0]).toMatchObject({ x: 9, stroke: "#f00" });
    act(() => void result.current.undo());
    expect(result.current.shapes[0]).toMatchObject({ x: 1, stroke: "#000" });
  });

  it("update ignores an id that is not there", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.update(rect(5, 5, "gone")));
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a"]);
  });

  it("remove drops one shape and is undoable", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => void result.current.commit(rect(2, 2, "b")));
    act(() => void result.current.remove("a"));
    expect(result.current.shapes.map((s) => s.id)).toEqual(["b"]);
    act(() => void result.current.undo());
    expect(result.current.shapes.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("clear drops shapes, draft and history", () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => void result.current.commit(rect(1, 1, "a")));
    act(() => result.current.setDraft(rect(9, 9, "draft")));
    act(() => result.current.clear());
    expect(result.current.shapes).toEqual([]);
    expect(result.current.draft).toBeNull();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
