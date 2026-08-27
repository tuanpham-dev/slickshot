import { describe, expect, it } from "vitest";
import { createCropRect, moveCropRect, resizeCropRect } from "./crop";

const IMG_W = 200;
const IMG_H = 100;

describe("createCropRect", () => {
  it("normalizes a drag in any direction", () => {
    expect(createCropRect({ x: 50, y: 40 }, { x: 10, y: 10 }, IMG_W, IMG_H)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
  });

  it("clamps to the image bounds when dragged past the top-left edge", () => {
    expect(createCropRect({ x: 0, y: 0 }, { x: -50, y: -50 }, IMG_W, IMG_H)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("clamps to the image bounds when dragged past the bottom-right edge", () => {
    const result = createCropRect({ x: 150, y: 80 }, { x: 500, y: 500 }, IMG_W, IMG_H);
    expect(result).toEqual({ x: 150, y: 80, w: IMG_W - 150, h: IMG_H - 80 });
  });

  it("never produces a zero-size rect (minimum 1x1) for a zero-delta drag", () => {
    const result = createCropRect({ x: 20, y: 20 }, { x: 20, y: 20 }, IMG_W, IMG_H);
    expect(result.w).toBeGreaterThanOrEqual(1);
    expect(result.h).toBeGreaterThanOrEqual(1);
  });
});

describe("resizeCropRect", () => {
  const orig = { x: 20, y: 20, w: 40, h: 40 };

  it("resizes normally within bounds", () => {
    expect(resizeCropRect(orig, "se", { x: 80, y: 80 }, IMG_W, IMG_H)).toEqual({ x: 20, y: 20, w: 60, h: 60 });
  });

  it("clamps the drag point to the image before resizing (dragging off-canvas doesn't overshoot)", () => {
    const clamped = resizeCropRect(orig, "se", { x: 9999, y: 9999 }, IMG_W, IMG_H);
    const unclamped = resizeCropRect(orig, "se", { x: IMG_W, y: IMG_H }, IMG_W, IMG_H);
    expect(clamped).toEqual(unclamped);
  });

  it("never shrinks below MIN_CROP_SIZE even when dragged past the opposite handle", () => {
    const result = resizeCropRect(orig, "se", { x: 20, y: 20 }, IMG_W, IMG_H);
    expect(result.w).toBeGreaterThanOrEqual(10);
    expect(result.h).toBeGreaterThanOrEqual(10);
  });

  it("keeps the rect within [0, imageWidth] x [0, imageHeight] after clamping", () => {
    const result = resizeCropRect({ x: 0, y: 0, w: 5, h: 5 }, "nw", { x: -100, y: -100 }, IMG_W, IMG_H);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + result.w).toBeLessThanOrEqual(IMG_W);
    expect(result.y + result.h).toBeLessThanOrEqual(IMG_H);
  });
});

describe("moveCropRect", () => {
  const orig = { x: 20, y: 20, w: 40, h: 40 };

  it("translates by dx/dy within bounds", () => {
    expect(moveCropRect(orig, 10, -5, IMG_W, IMG_H)).toEqual({ x: 30, y: 15, w: 40, h: 40 });
  });

  it("clamps so the rect never crosses the left/top edge", () => {
    expect(moveCropRect(orig, -100, -100, IMG_W, IMG_H)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
  });

  it("clamps so the rect never crosses the right/bottom edge", () => {
    const result = moveCropRect(orig, 1000, 1000, IMG_W, IMG_H);
    expect(result).toEqual({ x: IMG_W - orig.w, y: IMG_H - orig.h, w: 40, h: 40 });
  });

  it("preserves w/h exactly -- moving never resizes", () => {
    const result = moveCropRect(orig, 3, 3, IMG_W, IMG_H);
    expect(result.w).toBe(orig.w);
    expect(result.h).toBe(orig.h);
  });
});
