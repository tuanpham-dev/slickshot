import { describe, expect, it } from "vitest";
import type { MarkerShape, RectShape, Shape } from "../types";
import { createMarker, renumberMarkers } from "./marker";

const STYLE = {
  stroke: "#e2372f",
  fill: null,
  strokeWidth: 3,
  fontSize: 20,
  opacity: 1,
  pixelateBlock: 12,
  markerSize: 14,
  spotlightDim: 0.6,
  spotlightForm: "rect" as const,
  radius: 0,
};

function marker(id: string, number: number): MarkerShape {
  return { id, kind: "marker", x: 0, y: 0, number, color: "#000", radius: 14 };
}

function rect(id: string): RectShape {
  return { id, kind: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 };
}

function numbersOf(shapes: Shape[]): number[] {
  return shapes.filter((s): s is MarkerShape => s.kind === "marker").map((s) => s.number);
}

describe("renumberMarkers", () => {
  it("leaves an already-sequential list untouched", () => {
    const shapes = [marker("a", 1), marker("b", 2), marker("c", 3)];
    expect(numbersOf(renumberMarkers(shapes))).toEqual([1, 2, 3]);
  });

  it("returns already-correct markers by reference (no needless allocation)", () => {
    const a = marker("a", 1);
    const result = renumberMarkers([a]);
    expect(result[0]).toBe(a);
  });

  it("closes the gap left by a deleted middle marker", () => {
    // What's left after deleting the marker numbered 2 of 1,2,3.
    const shapes = [marker("a", 1), marker("c", 3)];
    expect(numbersOf(renumberMarkers(shapes))).toEqual([1, 2]);
  });

  it("renumbers from 1 when the first marker was deleted", () => {
    const shapes = [marker("b", 2), marker("c", 3)];
    expect(numbersOf(renumberMarkers(shapes))).toEqual([1, 2]);
  });

  it("collapses duplicate numbers into a strict sequence", () => {
    const shapes = [marker("a", 2), marker("b", 2), marker("c", 2)];
    expect(numbersOf(renumberMarkers(shapes))).toEqual([1, 2, 3]);
  });

  it("numbers by array position, ignoring the incoming numbers entirely", () => {
    const shapes = [marker("a", 99), marker("b", 7), marker("c", 42)];
    expect(numbersOf(renumberMarkers(shapes))).toEqual([1, 2, 3]);
  });

  it("leaves non-marker shapes untouched and preserves interleaved order", () => {
    const r1 = rect("r1");
    const r2 = rect("r2");
    const shapes = [r1, marker("a", 5), r2, marker("b", 9)];
    const result = renumberMarkers(shapes);
    expect(result.map((s) => s.id)).toEqual(["r1", "a", "r2", "b"]);
    expect(result[0]).toBe(r1);
    expect(result[2]).toBe(r2);
    expect(numbersOf(result)).toEqual([1, 2]);
  });

  it("handles a list with no markers at all", () => {
    const shapes = [rect("r1"), rect("r2")];
    expect(renumberMarkers(shapes).map((s) => s.id)).toEqual(["r1", "r2"]);
  });

  it("handles an empty list", () => {
    expect(renumberMarkers([])).toEqual([]);
  });

  it("does not mutate the input array or its shapes", () => {
    const original = marker("a", 9);
    const shapes = [original];
    renumberMarkers(shapes);
    expect(original.number).toBe(9);
    expect(shapes).toHaveLength(1);
  });
});

describe("createMarker", () => {
  it("places the marker at the clicked point with the style's color and size", () => {
    const m = createMarker("id", { x: 30, y: 40 }, 2, STYLE);
    expect(m).toMatchObject({ kind: "marker", x: 30, y: 40, number: 2, color: STYLE.stroke, radius: STYLE.markerSize });
  });
});
