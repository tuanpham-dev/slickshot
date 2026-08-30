import { describe, expect, it } from "vitest";
import { applyStyleToShape, styleOfShape, toolForShape } from "./style";
import { DEFAULT_STYLE, type Shape } from "../editor/types";

const rect: Shape = {
  id: "r",
  kind: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  stroke: "#000",
  fill: null,
  strokeWidth: 2,
};
const text: Shape = {
  id: "t",
  kind: "text",
  x: 0,
  y: 0,
  text: "hi",
  color: "#000",
  fontSize: 20,
  background: false,
};
const stamp: Shape = { id: "s", kind: "stamp", x: 0, y: 0, size: 56, emoji: "✅" };
const censor: Shape = { id: "c", kind: "pixelate", x: 0, y: 0, w: 10, h: 10, blockSize: 12 };
const marker: Shape = { id: "m", kind: "marker", x: 0, y: 0, number: 1, color: "#000", radius: 14 };

describe("applyStyleToShape", () => {
  it("writes stroke and width onto a rect", () => {
    expect(applyStyleToShape(rect, { stroke: "#f00", strokeWidth: 6 })).toMatchObject({
      stroke: "#f00",
      strokeWidth: 6,
    });
  });

  it("routes the same colour key to a text shape's own field", () => {
    expect(applyStyleToShape(text, { stroke: "#f00" })).toMatchObject({ color: "#f00" });
  });

  it("ignores keys a shape kind has no field for", () => {
    // A stamp has no stroke; writing one would invent a field render() then
    // has to defend against.
    const out = applyStyleToShape(stamp, { stroke: "#f00", strokeWidth: 9 });
    expect(out).not.toHaveProperty("stroke");
    expect(out).not.toHaveProperty("strokeWidth");
  });

  it("does not mutate its input", () => {
    applyStyleToShape(rect, { stroke: "#f00" });
    expect(rect.stroke).toBe("#000");
  });

  it("leaves untouched fields alone", () => {
    const out = applyStyleToShape(rect, { stroke: "#f00" });
    expect(out).toMatchObject({ w: 10, h: 10, strokeWidth: 2 });
  });

  it("clears a rect's fill when the partial says null", () => {
    const filled = { ...rect, fill: "#0f0" } as Shape;
    expect(applyStyleToShape(filled, { fill: null })).toMatchObject({ fill: null });
  });

  it("maps censor keys onto their differently-named fields", () => {
    expect(
      applyStyleToShape(censor, { censorMode: "solid", censorColor: "#123456", pixelateBlock: 30 }),
    ).toMatchObject({ mode: "solid", color: "#123456", blockSize: 30 });
  });

  it("resizes a stamp from the marker size, matching how one is created", () => {
    expect(applyStyleToShape(stamp, { markerSize: 20 })).toMatchObject({ size: 80 });
  });

  it("never shrinks a stamp below the floor createStamp enforces", () => {
    expect(applyStyleToShape(stamp, { markerSize: 1 })).toMatchObject({ size: 12 });
  });

  it("an empty partial is a no-op", () => {
    expect(applyStyleToShape(rect, {})).toEqual(rect);
  });
});

describe("styleOfShape", () => {
  it("reads a rect's own values back out", () => {
    expect(styleOfShape({ ...rect, stroke: "#abc", strokeWidth: 7 })).toMatchObject({
      stroke: "#abc",
      strokeWidth: 7,
    });
  });

  it("reports a text shape's colour under the shared stroke key", () => {
    expect(styleOfShape({ ...text, color: "#abc" })).toMatchObject({ stroke: "#abc" });
  });

  // An optional field a shape never set stays absent, so the session style
  // supplies it -- reporting a default here would write it back onto the
  // shape the moment it was selected.
  it("omits optional fields the shape does not carry", () => {
    expect(styleOfShape(censor)).not.toHaveProperty("censorMode");
    const bareArrow: Shape = {
      id: "a",
      kind: "arrow",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stroke: "#000",
      strokeWidth: 2,
    };
    expect(styleOfShape(bareArrow)).not.toHaveProperty("arrowStyle");
    // ...and the merge still shows what the shape actually renders as.
    expect({ ...DEFAULT_STYLE, ...styleOfShape(bareArrow) }.arrowStyle).toBe("single");
    expect({ ...DEFAULT_STYLE, ...styleOfShape(censor) }.censorMode).toBe("pixelate");
  });

  it("reports an optional field the shape does carry", () => {
    expect(styleOfShape({ ...censor, mode: "blur" } as Shape)).toMatchObject({
      censorMode: "blur",
    });
  });

  // The two directions have to agree, or editing a selected shape would move
  // a different property than the control claims to change.
  it("round-trips through applyStyleToShape for every kind it knows", () => {
    const arrow: Shape = {
      id: "a",
      kind: "arrow",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stroke: "#000",
      strokeWidth: 2,
      style: "double",
      banner: true,
    };
    for (const shape of [rect, text, stamp, censor, marker, arrow]) {
      const applied = applyStyleToShape(shape, styleOfShape(shape));
      expect(applied).toEqual(shape);
    }
  });

  it("merged over a session style, a shape's values win", () => {
    const merged = { ...DEFAULT_STYLE, ...styleOfShape({ ...rect, strokeWidth: 9 }) };
    expect(merged.strokeWidth).toBe(9);
    // Keys the shape says nothing about keep the session value.
    expect(merged.stampEmoji).toBe(DEFAULT_STYLE.stampEmoji);
  });
});

describe("toolForShape", () => {
  it("names the tool whose options describe the shape", () => {
    expect(toolForShape(rect)).toBe("rect");
    expect(toolForShape(censor)).toBe("pixelate");
  });

  it("has nothing to offer for an inserted image", () => {
    expect(toolForShape({ id: "i", kind: "image", x: 0, y: 0, w: 1, h: 1, dataUrl: "" })).toBeNull();
  });
});
