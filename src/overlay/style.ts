import type { Shape, Style, ToolId } from "../editor/types";

/** The overlay drives one set of controls from two places: the style the next
 * shape will be created with, and the shape currently selected. These two
 * functions are the translation between `Style`'s flat keys and the per-kind
 * field names shapes actually use (`stroke` on a rect, `color` on text, and
 * so on), so neither side has to know about the other's shape.
 *
 * The mapping mirrors what the `create*` factories in `editor/tools/*` do at
 * creation time -- if one drifts from the other, editing a shape would change
 * a different property than drawing it did. */

/** Applies a style change to a shape, touching only the fields that shape
 * kind actually has. Unrelated keys are ignored rather than written blindly,
 * so a stroke-width change cannot invent a `strokeWidth` on a stamp. */
export function applyStyleToShape(shape: Shape, partial: Partial<Style>): Shape {
  const next = { ...shape } as Shape & Record<string, unknown>;
  const set = (key: string, value: unknown) => {
    if (value !== undefined) next[key] = value;
  };

  switch (shape.kind) {
    case "rect":
      set("stroke", partial.stroke);
      set("strokeWidth", partial.strokeWidth);
      if ("fill" in partial) set("fill", partial.fill);
      set("radius", partial.radius);
      break;
    case "ellipse":
      set("stroke", partial.stroke);
      set("strokeWidth", partial.strokeWidth);
      if ("fill" in partial) set("fill", partial.fill);
      break;
    case "arrow":
      set("stroke", partial.stroke);
      set("strokeWidth", partial.strokeWidth);
      set("style", partial.arrowStyle);
      set("banner", partial.arrowBanner);
      break;
    case "freehand":
      set("stroke", partial.stroke);
      set("strokeWidth", partial.strokeWidth);
      break;
    case "text":
      set("color", partial.stroke);
      set("fontSize", partial.fontSize);
      set("bold", partial.textBold);
      set("italic", partial.textItalic);
      set("underline", partial.textUnderline);
      set("align", partial.textAlign);
      if ("textBgColor" in partial) set("bgColor", partial.textBgColor);
      break;
    case "highlight":
      set("color", partial.stroke);
      break;
    case "pixelate":
      set("mode", partial.censorMode);
      set("color", partial.censorColor);
      set("blockSize", partial.pixelateBlock);
      break;
    case "spotlight":
      set("dimOpacity", partial.spotlightDim);
      set("form", partial.spotlightForm);
      set("radius", partial.radius);
      break;
    case "marker":
      set("color", partial.stroke);
      set("radius", partial.markerSize);
      break;
    case "stamp":
      set("emoji", partial.stampEmoji);
      // Stamps are sized from the marker slider, four times over -- the same
      // relationship `createStamp` uses, so the control reads consistently
      // whether it is placing a stamp or editing one.
      if (partial.markerSize !== undefined) {
        next.size = Math.max(12, partial.markerSize * 4);
      }
      break;
    case "loupe":
      set("stroke", partial.stroke);
      set("strokeWidth", partial.strokeWidth);
      set("factor", partial.loupeFactor);
      break;
  }
  return next as Shape;
}

/** Drops keys whose value is `undefined`, so an optional field a shape does
 * not carry stays absent rather than being reported as a default and then
 * written back on -- which would make merely selecting a shape modify it. */
function defined(partial: Partial<Style>): Partial<Style> {
  return Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  ) as Partial<Style>;
}

/** Reads a shape's own values back out as a style, so selecting a shape shows
 * that shape's settings rather than whatever was last drawn. Keys the shape
 * has no equivalent for -- and optional fields it never set -- are left
 * absent; the caller merges the result over its session style, whose defaults
 * are the same values the `create*` factories would have used anyway. */
export function styleOfShape(shape: Shape): Partial<Style> {
  switch (shape.kind) {
    case "rect":
      return defined({
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth,
        fill: shape.fill,
        radius: shape.radius,
      });
    case "ellipse":
      return defined({ stroke: shape.stroke, strokeWidth: shape.strokeWidth, fill: shape.fill });
    case "arrow":
      return defined({
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth,
        arrowStyle: shape.style,
        arrowBanner: shape.banner,
      });
    case "freehand":
      return defined({ stroke: shape.stroke, strokeWidth: shape.strokeWidth });
    case "text":
      return defined({
        stroke: shape.color,
        fontSize: shape.fontSize,
        textBold: shape.bold,
        textItalic: shape.italic,
        textUnderline: shape.underline,
        textAlign: shape.align,
        textBgColor: shape.bgColor,
      });
    case "highlight":
      return defined({ stroke: shape.color });
    case "pixelate":
      return defined({
        censorMode: shape.mode,
        censorColor: shape.color,
        pixelateBlock: shape.blockSize,
      });
    case "spotlight":
      return defined({
        spotlightDim: shape.dimOpacity,
        spotlightForm: shape.form,
        radius: shape.radius,
      });
    case "marker":
      return defined({ stroke: shape.color, markerSize: shape.radius });
    case "stamp":
      return defined({ stampEmoji: shape.emoji, markerSize: Math.round(shape.size / 4) });
    case "loupe":
      return defined({
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth,
        loupeFactor: shape.factor,
      });
    default:
      return {};
  }
}

/** Which tool's option set describes a shape, so a selected shape shows the
 * same controls the tool that drew it would. `null` for kinds the overlay
 * cannot draw (inserted images), which have nothing to offer. Arrow and Line
 * share one shape kind and one control set, so `arrow` covers both. */
export function toolForShape(shape: Shape): ToolId | null {
  return shape.kind === "image" ? null : shape.kind;
}
