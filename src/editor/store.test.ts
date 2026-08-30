import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "./store";
import type { MarkerShape, RectShape, Shape } from "./types";

function marker(id: string, number: number): MarkerShape {
  return { id, kind: "marker", x: 0, y: 0, number, color: "#000", radius: 14 };
}

function rect(id: string): RectShape {
  return { id, kind: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 };
}

function numbers(): number[] {
  return useEditorStore
    .getState()
    .shapes.filter((s: Shape): s is MarkerShape => s.kind === "marker")
    .map((s) => s.number);
}

describe("editor store — marker numbering", () => {
  beforeEach(() => {
    // `setImage` is the store's own full reset (shapes, history, dirty).
    useEditorStore.getState().setImage("test-image", 100, 100);
  });

  it("numbers markers 1..n as they're added", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 1));
    addShape(marker("c", 1));
    expect(numbers()).toEqual([1, 2, 3]);
  });

  it("renumbers the survivors when a middle marker is deleted", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 2));
    addShape(marker("c", 3));

    useEditorStore.getState().removeShape("b");

    expect(numbers()).toEqual([1, 2]);
    expect(useEditorStore.getState().shapes.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("continues from the new count after a deletion, not the old high-water mark", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 2));
    addShape(marker("c", 3));
    useEditorStore.getState().removeShape("b");

    useEditorStore.getState().addShape(marker("d", 1));

    expect(numbers()).toEqual([1, 2, 3]);
  });

  it("gives a duplicated marker the next sequential number, not a copy of the source's", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 2));

    useEditorStore.getState().select("a");
    useEditorStore.getState().duplicateSelected();

    expect(numbers()).toEqual([1, 2, 3]);
    expect(new Set(numbers()).size).toBe(3);
  });

  it("restores the pre-delete numbering on undo", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 2));
    addShape(marker("c", 3));
    useEditorStore.getState().removeShape("b");
    expect(numbers()).toEqual([1, 2]);

    useEditorStore.getState().undo();

    expect(numbers()).toEqual([1, 2, 3]);
    expect(useEditorStore.getState().shapes.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("re-applies the deletion (and its renumbering) on redo", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 2));
    addShape(marker("c", 3));
    useEditorStore.getState().removeShape("b");
    useEditorStore.getState().undo();

    useEditorStore.getState().redo();

    expect(numbers()).toEqual([1, 2]);
  });

  it("ignores non-marker shapes when numbering", () => {
    const { addShape } = useEditorStore.getState();
    addShape(rect("r1"));
    addShape(marker("a", 1));
    addShape(rect("r2"));
    addShape(marker("b", 1));

    expect(numbers()).toEqual([1, 2]);

    useEditorStore.getState().removeShape("r1");
    expect(numbers()).toEqual([1, 2]);
  });

  it("starts numbering from 1 again after a new image is loaded", () => {
    const { addShape } = useEditorStore.getState();
    addShape(marker("a", 1));
    addShape(marker("b", 2));

    useEditorStore.getState().setImage("another-image", 50, 50);
    useEditorStore.getState().addShape(marker("c", 1));

    expect(numbers()).toEqual([1]);
  });
});

describe("adjustments", () => {
  it("start at identity and are undoable like any other edit", () => {
    const store = useEditorStore.getState();
    store.setImage("img", 100, 100);
    expect(useEditorStore.getState().adjustments.brightness).toBe(100);

    useEditorStore.getState().setAdjustments({ brightness: 130 });
    expect(useEditorStore.getState().adjustments.brightness).toBe(130);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().adjustments.brightness).toBe(100);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().adjustments.brightness).toBe(130);
  });

  it("reset when a new capture arrives", () => {
    useEditorStore.getState().setImage("img", 100, 100);
    useEditorStore.getState().setAdjustments({ saturation: 20, invert: true });
    useEditorStore.getState().setImage("next", 100, 100);
    const { adjustments } = useEditorStore.getState();
    expect(adjustments.saturation).toBe(100);
    expect(adjustments.invert).toBe(false);
  });
});

describe("flipImage", () => {
  it("mirrors every shape and clears history", () => {
    const store = useEditorStore.getState();
    store.setImage("img", 200, 100);
    useEditorStore.getState().addShape({
      id: "r", kind: "rect", x: 10, y: 20, w: 40, h: 30, stroke: "#000", fill: null, strokeWidth: 2,
    });

    useEditorStore.getState().flipImage("h");
    const rect = useEditorStore.getState().shapes[0];
    // The rect's right edge (x+w = 50) becomes its distance from the right,
    // so the mirrored left edge is 200 - 50 = 150.
    expect(rect).toMatchObject({ x: 150, y: 20, w: 40, h: 30 });
    expect(useEditorStore.getState().past).toHaveLength(0);
  });

  it("is its own inverse", () => {
    useEditorStore.getState().setImage("img", 200, 100);
    const original = {
      id: "r", kind: "rect" as const, x: 10, y: 20, w: 40, h: 30, stroke: "#000", fill: null, strokeWidth: 2,
    };
    useEditorStore.getState().addShape(original);
    useEditorStore.getState().flipImage("v");
    useEditorStore.getState().flipImage("v");
    expect(useEditorStore.getState().shapes[0]).toMatchObject({ x: 10, y: 20, w: 40, h: 30 });
  });
});

describe("adjustOpen", () => {
  it("closes when a tool is picked, so the tool's own settings can show", () => {
    useEditorStore.getState().setImage("img", 100, 100);
    useEditorStore.getState().setAdjustOpen(true);
    expect(useEditorStore.getState().adjustOpen).toBe(true);

    useEditorStore.getState().setTool("rect");
    expect(useEditorStore.getState().adjustOpen).toBe(false);
  });

  it("closes when a shape is selected, including re-selecting the same one", () => {
    useEditorStore.getState().setImage("img", 100, 100);
    const shape = {
      id: "r", kind: "rect" as const, x: 0, y: 0, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 1,
    };
    useEditorStore.getState().addShape(shape);

    useEditorStore.getState().setAdjustOpen(true);
    // Re-selecting the already-selected shape must still close it: a check
    // on `selectedId` changing would miss this case.
    useEditorStore.getState().select("r");
    expect(useEditorStore.getState().adjustOpen).toBe(false);
  });

  it("stays open when the canvas is merely deselected", () => {
    useEditorStore.getState().setImage("img", 100, 100);
    useEditorStore.getState().setAdjustOpen(true);
    useEditorStore.getState().select(null);
    expect(useEditorStore.getState().adjustOpen).toBe(true);
  });

  it("resets when a new capture arrives", () => {
    useEditorStore.getState().setAdjustOpen(true);
    useEditorStore.getState().setImage("next", 100, 100);
    expect(useEditorStore.getState().adjustOpen).toBe(false);
  });
});

describe("line and arrow share one shape", () => {
  it("presets the headless style when the Line tool is picked", () => {
    useEditorStore.getState().setImage("img", 100, 100);
    useEditorStore.getState().setTool("line");
    expect(useEditorStore.getState().style.arrowStyle).toBe("none");
  });

  it("gives the Arrow tool a head when coming from Line", () => {
    useEditorStore.getState().setTool("line");
    useEditorStore.getState().setTool("arrow");
    expect(useEditorStore.getState().style.arrowStyle).toBe("single");
  });

  it("keeps a deliberately chosen head when returning to the Arrow tool", () => {
    useEditorStore.getState().setTool("arrow");
    useEditorStore.getState().setStyle({ arrowStyle: "double" });
    useEditorStore.getState().setTool("rect");
    useEditorStore.getState().setTool("arrow");
    expect(useEditorStore.getState().style.arrowStyle).toBe("double");
  });

  it("leaves other tools' style untouched", () => {
    useEditorStore.getState().setTool("arrow");
    useEditorStore.getState().setStyle({ arrowStyle: "tail" });
    useEditorStore.getState().setTool("rect");
    expect(useEditorStore.getState().style.arrowStyle).toBe("tail");
  });
});
