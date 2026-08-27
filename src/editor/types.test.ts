import { describe, expect, it } from "vitest";
import {
  clampHandles,
  handlesFor,
  hitTest,
  isEndpointLike,
  isRectLike,
  rectHandles,
  shapeBounds,
  type ArrowShape,
  type FreehandShape,
  type MarkerShape,
  type RectShape,
  type TextShape,
} from "./types";

const rect: RectShape = { id: "1", kind: "rect", x: 10, y: 20, w: 30, h: 40, stroke: "#000", fill: null, strokeWidth: 2 };
const arrow: ArrowShape = { id: "2", kind: "arrow", x1: 10, y1: 10, x2: 40, y2: 30, stroke: "#000", strokeWidth: 2 };

describe("shapeBounds", () => {
  it("returns x/y/w/h directly for rect-like shapes", () => {
    expect(shapeBounds(rect)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("normalizes an arrow drawn in any direction to a positive-size box", () => {
    const reversed: ArrowShape = { ...arrow, x1: 40, y1: 30, x2: 10, y2: 10 };
    expect(shapeBounds(arrow)).toEqual(shapeBounds(reversed));
    expect(shapeBounds(arrow)).toEqual({ x: 10, y: 10, w: 30, h: 20 });
  });

  it("bounds a freehand path by its min/max points", () => {
    const freehand: FreehandShape = {
      id: "3",
      kind: "freehand",
      points: [{ x: 5, y: 50 }, { x: 20, y: 10 }, { x: -5, y: 30 }],
      stroke: "#000",
      strokeWidth: 1,
    };
    expect(shapeBounds(freehand)).toEqual({ x: -5, y: 10, w: 25, h: 40 });
  });

  it("bounds a freehand path with a single point as a zero-size box (no crash)", () => {
    const freehand: FreehandShape = {
      id: "4",
      kind: "freehand",
      points: [{ x: 5, y: 5 }],
      stroke: "#000",
      strokeWidth: 1,
    };
    expect(shapeBounds(freehand)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });

  it("estimates multi-line text height from the number of lines", () => {
    const oneLine: TextShape = { id: "5", kind: "text", x: 0, y: 0, text: "hi", color: "#000", fontSize: 10, background: false };
    const twoLine: TextShape = { ...oneLine, text: "hi\nthere" };
    expect(shapeBounds(twoLine).h).toBe(shapeBounds(oneLine).h * 2);
  });

  it("bounds a marker as a square around its center, sized by radius", () => {
    const marker: MarkerShape = { id: "6", kind: "marker", x: 100, y: 100, number: 1, color: "#000", radius: 12 };
    expect(shapeBounds(marker)).toEqual({ x: 88, y: 88, w: 24, h: 24 });
  });
});

describe("isRectLike / isEndpointLike", () => {
  it("classifies a rect as rect-like, not endpoint-like", () => {
    expect(isRectLike(rect)).toBe(true);
    expect(isEndpointLike(rect)).toBe(false);
  });

  it("classifies an arrow as endpoint-like, not rect-like", () => {
    expect(isRectLike(arrow)).toBe(false);
    expect(isEndpointLike(arrow)).toBe(true);
  });
});

describe("rectHandles", () => {
  it("places all 8 handles at the expected fractions of the box", () => {
    const handles = rectHandles({ x: 0, y: 0, w: 100, h: 50 });
    expect(handles).toEqual([
      { id: "nw", x: 0, y: 0 },
      { id: "n", x: 50, y: 0 },
      { id: "ne", x: 100, y: 0 },
      { id: "e", x: 100, y: 25 },
      { id: "se", x: 100, y: 50 },
      { id: "s", x: 50, y: 50 },
      { id: "sw", x: 0, y: 50 },
      { id: "w", x: 0, y: 25 },
    ]);
  });

  it("degenerates to a single point for a zero-size box (no NaN)", () => {
    const handles = rectHandles({ x: 5, y: 5, w: 0, h: 0 });
    expect(handles.every((h) => h.x === 5 && h.y === 5)).toBe(true);
  });
});

describe("clampHandles", () => {
  it("leaves handles untouched when they're within the inset margin", () => {
    const handles = rectHandles({ x: 10, y: 10, w: 80, h: 80 });
    expect(clampHandles(handles, 100, 100)).toEqual(handles);
  });

  it("pulls handles on the canvas edge inward by the inset", () => {
    const handles = rectHandles({ x: 0, y: 0, w: 100, h: 100 });
    const clamped = clampHandles(handles, 100, 100, 5);
    const nw = clamped.find((h) => h.id === "nw")!;
    const se = clamped.find((h) => h.id === "se")!;
    expect(nw).toEqual({ id: "nw", x: 5, y: 5 });
    expect(se).toEqual({ id: "se", x: 95, y: 95 });
  });

  it("still resolves to a finite in-bounds value when the canvas is smaller than 2x the inset", () => {
    // canvasW - inset (3) < inset (5): the outer Math.min wins over the
    // inner Math.max, so the handle sits at canvasW - inset rather than
    // inset -- not centered, but finite and on-canvas, not NaN.
    const clamped = clampHandles([{ id: "nw", x: 50, y: 50 }], 8, 8, 5);
    expect(clamped[0]).toEqual({ id: "nw", x: 3, y: 3 });
  });
});

describe("hitTest", () => {
  it("hits inside the shape bounds", () => {
    expect(hitTest(rect, { x: 20, y: 30 })).toBe(true);
  });

  it("hits within the padding just outside the bounds", () => {
    expect(hitTest(rect, { x: 10 - 5, y: 20 }, 6)).toBe(true);
  });

  it("misses just beyond the padding", () => {
    expect(hitTest(rect, { x: 10 - 7, y: 20 }, 6)).toBe(false);
  });

  it("uses a default pad of 6 when not specified", () => {
    expect(hitTest(rect, { x: 10 - 6, y: 20 })).toBe(true);
    expect(hitTest(rect, { x: 10 - 7, y: 20 })).toBe(false);
  });
});

describe("handlesFor", () => {
  it("returns start/end handles for endpoint shapes", () => {
    expect(handlesFor(arrow)).toEqual([
      { id: "start", x: 10, y: 10 },
      { id: "end", x: 40, y: 30 },
    ]);
  });

  it("returns 8 rect handles for rect-like shapes", () => {
    expect(handlesFor(rect)).toHaveLength(8);
  });

  it("returns no handles for a shape kind that is neither (text)", () => {
    const text: TextShape = { id: "7", kind: "text", x: 0, y: 0, text: "hi", color: "#000", fontSize: 10, background: false };
    expect(handlesFor(text)).toEqual([]);
  });
});
