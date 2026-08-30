import { describe, expect, it } from "vitest";
import { pointerIntent } from "./pointer";

const selection = { x: 100, y: 100, w: 200, h: 150 };
const inside = { x: 180, y: 160 };
const outside = { x: 600, y: 600 };

describe("pointerIntent", () => {
  it("starts a new selection when nothing is selected yet", () => {
    expect(pointerIntent(inside, { selection: null, activeTool: null, handle: null })).toBe(
      "new-selection",
    );
  });

  it("starts a new selection outside the current one", () => {
    expect(pointerIntent(outside, { selection, activeTool: null, handle: null })).toBe(
      "new-selection",
    );
  });

  it("moves the selection when pressed inside with no tool armed", () => {
    expect(pointerIntent(inside, { selection, activeTool: null, handle: null })).toBe("move");
  });

  it("draws when pressed inside with a tool armed", () => {
    expect(pointerIntent(inside, { selection, activeTool: "arrow", handle: null })).toBe("draw");
  });

  it("resizes from a handle even with a tool armed -- handle beats draw", () => {
    expect(pointerIntent(inside, { selection, activeTool: "arrow", handle: "se" })).toBe("resize");
  });

  it("resizes from a handle with no tool armed", () => {
    expect(pointerIntent(inside, { selection, activeTool: null, handle: "nw" })).toBe("resize");
  });

  it("draws rather than moves -- draw beats move", () => {
    const withTool = pointerIntent(inside, { selection, activeTool: "rect", handle: null });
    const withoutTool = pointerIntent(inside, { selection, activeTool: null, handle: null });
    expect(withTool).toBe("draw");
    expect(withoutTool).toBe("move");
  });

  it("still starts a new selection outside, even with a tool armed", () => {
    // Arming a tool must not turn the whole screen into a canvas: outside the
    // selection the overlay is still a region picker.
    expect(pointerIntent(outside, { selection, activeTool: "arrow", handle: null })).toBe(
      "new-selection",
    );
  });

  it("picks a shape when the select tool is armed", () => {
    expect(pointerIntent(inside, { selection, activeTool: "select", handle: null })).toBe(
      "pick-shape",
    );
  });

  it("a handle still resizes the region with the select tool armed", () => {
    expect(pointerIntent(inside, { selection, activeTool: "select", handle: "se" })).toBe("resize");
  });

  it("the select tool outside the selection still starts a new one", () => {
    expect(pointerIntent(outside, { selection, activeTool: "select", handle: null })).toBe(
      "new-selection",
    );
  });

  it("never returns \"draw\" when no tool is armed", () => {
    const points = [inside, outside, { x: 100, y: 100 }, { x: 299, y: 249 }];
    const handles = [null, "nw", "se", "n"] as const;
    for (const point of points) {
      for (const handle of handles) {
        for (const sel of [selection, null]) {
          const intent = pointerIntent(point, { selection: sel, activeTool: null, handle });
          expect(intent).not.toBe("draw");
          expect(intent).not.toBe("pick-shape");
        }
      }
    }
  });

  it("ignores a stale handle when there is no selection", () => {
    expect(pointerIntent(inside, { selection: null, activeTool: null, handle: "se" })).toBe(
      "new-selection",
    );
  });
});
