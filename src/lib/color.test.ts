import { describe, expect, it } from "vitest";
import { formatColor, measurementLabel, toHex, toHslString, toRgbString } from "./color";

describe("toHex", () => {
  it("uppercases and pads single-digit channels", () => {
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(toHex({ r: 15, g: 15, b: 15 })).toBe("#0F0F0F");
  });

  it("formats pure white", () => {
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe("#FFFFFF");
  });

  it("formats a mixed channel value", () => {
    expect(toHex({ r: 102, g: 144, b: 240 })).toBe("#6690F0");
  });
});

describe("toRgbString", () => {
  it("formats as rgb(r, g, b)", () => {
    expect(toRgbString({ r: 1, g: 2, b: 3 })).toBe("rgb(1, 2, 3)");
  });
});

describe("toHslString", () => {
  it("formats pure black without dividing by zero (delta === 0)", () => {
    expect(toHslString({ r: 0, g: 0, b: 0 })).toBe("hsl(0, 0%, 0%)");
  });

  it("formats pure white without dividing by zero (delta === 0)", () => {
    expect(toHslString({ r: 255, g: 255, b: 255 })).toBe("hsl(0, 0%, 100%)");
  });

  it("formats a gray (r === g === b, delta === 0) with 0% saturation", () => {
    expect(toHslString({ r: 128, g: 128, b: 128 })).toBe("hsl(0, 0%, 50%)");
  });

  it("formats pure red as hue 0", () => {
    expect(toHslString({ r: 255, g: 0, b: 0 })).toBe("hsl(0, 100%, 50%)");
  });

  it("formats pure green as hue 120", () => {
    expect(toHslString({ r: 0, g: 255, b: 0 })).toBe("hsl(120, 100%, 50%)");
  });

  it("formats pure blue as hue 240", () => {
    expect(toHslString({ r: 0, g: 0, b: 255 })).toBe("hsl(240, 100%, 50%)");
  });

  it("never emits a negative hue when the modulo result is negative", () => {
    // max === r branch with a negative ((g-b)/delta) % 6, e.g. magenta-leaning red.
    const { r, g, b } = { r: 255, g: 0, b: 128 };
    const out = toHslString({ r, g, b });
    const hue = Number(out.match(/^hsl\((\d+),/)?.[1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

describe("formatColor", () => {
  const rgb = { r: 0, g: 0, b: 0 };

  it("dispatches to hex by default", () => {
    expect(formatColor(rgb, "hex")).toBe(toHex(rgb));
  });

  it("dispatches to rgb", () => {
    expect(formatColor(rgb, "rgb")).toBe(toRgbString(rgb));
  });

  it("dispatches to hsl", () => {
    expect(formatColor(rgb, "hsl")).toBe(toHslString(rgb));
  });
});

describe("measurementLabel", () => {
  it("reports zero distance for identical points", () => {
    expect(measurementLabel({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe("0 × 0 (0 px)");
  });

  it("takes the absolute value regardless of drag direction", () => {
    expect(measurementLabel({ x: 10, y: 10 }, { x: 0, y: 0 })).toBe(measurementLabel({ x: 0, y: 0 }, { x: 10, y: 10 }));
  });

  it("rounds fractional pixel deltas before computing distance", () => {
    // dx = round(3.4) = 3, dy = round(4.6) = 5, distance = round(hypot(3, 5)) = 6.
    expect(measurementLabel({ x: 0, y: 0 }, { x: 3.4, y: 4.6 })).toBe("3 × 5 (6 px)");
  });

  it("computes the straight-line (hypotenuse) distance, not the sum of axes", () => {
    expect(measurementLabel({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe("3 × 4 (5 px)");
  });
});
