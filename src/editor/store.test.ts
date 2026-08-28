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
