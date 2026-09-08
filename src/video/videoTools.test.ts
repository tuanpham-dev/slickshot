import { describe, expect, it } from "vitest";
import type { Shape } from "../editor/types";
import { extractCensors, hasEdits, shapesForOverlay, VIDEO_TOOLS } from "./videoTools";

function censor(over: Partial<Extract<Shape, { kind: "pixelate" }>> = {}): Shape {
  return {
    id: "c1",
    kind: "pixelate",
    x: 10,
    y: 20,
    w: 30,
    h: 40,
    blockSize: 12,
    ...over,
  } as Shape;
}

function rect(): Shape {
  return {
    id: "r1",
    kind: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    style: { stroke: "#f00", fill: null, strokeWidth: 2, opacity: 1 },
  } as unknown as Shape;
}

describe("extractCensors", () => {
  it("reads a pixelate censor with its block size", () => {
    expect(extractCensors([censor()])).toEqual([
      { rect: { x: 10, y: 20, w: 30, h: 40 }, kind: "pixelate", block: 12 },
    ]);
  });

  it("reads a solid censor's colour as separate channels", () => {
    const [c] = extractCensors([censor({ mode: "solid", color: "#ff8000" })]);
    expect(c).toEqual({
      rect: { x: 10, y: 20, w: 30, h: 40 },
      kind: "solid",
      r: 255,
      g: 128,
      b: 0,
    });
  });

  it("expands a three-digit hex", () => {
    const [c] = extractCensors([censor({ mode: "solid", color: "#0f0" })]);
    expect(c).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("turns a blur censor's block size into a sigma", () => {
    const [c] = extractCensors([censor({ mode: "blur", blockSize: 10 })]);
    expect(c).toEqual({ rect: { x: 10, y: 20, w: 30, h: 40 }, kind: "blur", sigma: 5 });
  });

  it("clamps sigma so a huge block cannot make the export crawl", () => {
    const [c] = extractCensors([censor({ mode: "blur", blockSize: 400 })]);
    expect(c).toMatchObject({ sigma: 12 });
  });

  it("treats a shape with no mode as pixelate, the original behaviour", () => {
    const [c] = extractCensors([censor({ mode: undefined })]);
    expect(c).toMatchObject({ kind: "pixelate" });
  });

  it("normalises a rect dragged right-to-left", () => {
    // The editor stores the drag as-is, so w/h can be negative; a negative
    // width would clamp to nothing once it reached Rust.
    const [c] = extractCensors([censor({ x: 100, y: 100, w: -40, h: -20 })]);
    expect(c.rect).toEqual({ x: 60, y: 80, w: 40, h: 20 });
  });

  it("drops a zero-area censor rather than sending it", () => {
    expect(extractCensors([censor({ w: 0 })])).toEqual([]);
  });

  it("ignores every other kind of shape", () => {
    expect(extractCensors([rect()])).toEqual([]);
  });

  it("keeps several censors in order", () => {
    const shapes = [censor({ x: 1 }), rect(), censor({ x: 2, mode: "solid" })];
    const out = extractCensors(shapes);
    expect(out).toHaveLength(2);
    expect(out[0].rect.x).toBe(1);
    expect(out[1].rect.x).toBe(2);
  });
});

describe("shapesForOverlay", () => {
  it("keeps annotations and drops censors", () => {
    // Censors must not be baked into the overlay: one flattened image over a
    // moving clip would freeze the censored pixels at one frame.
    const shapes = [rect(), censor()];
    const out = shapesForOverlay(shapes);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("rect");
  });

  it("returns an empty list for censors alone", () => {
    expect(shapesForOverlay([censor()])).toEqual([]);
  });
});

describe("VIDEO_TOOLS", () => {
  it("offers crop and the drawing tools", () => {
    expect(VIDEO_TOOLS).toContain("crop");
    expect(VIDEO_TOOLS).toContain("rect");
    expect(VIDEO_TOOLS).toContain("pixelate");
  });

  it("leaves out the tools that read pixels from a still frame", () => {
    for (const id of ["eyedropper", "ocr", "loupe", "measure", "spotlight"]) {
      expect(VIDEO_TOOLS).not.toContain(id);
    }
  });
});

describe("hasEdits", () => {
  it("is false for an untouched clip", () => {
    expect(hasEdits([], null, 1)).toBe(false);
  });

  it("is true once anything is drawn, cropped or sped up", () => {
    expect(hasEdits([rect()], null, 1)).toBe(true);
    expect(hasEdits([], { x: 0, y: 0, w: 10, h: 10 }, 1)).toBe(true);
    expect(hasEdits([], null, 2)).toBe(true);
  });
});
