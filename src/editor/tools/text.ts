import type { ImgPoint, Style, TextShape } from "../types";

export function createText(
  id: string,
  point: ImgPoint,
  text: string,
  color: string,
  fontSize: number,
  /** Optional so existing callers that only carry color/size keep working;
   * when passed, the new text inherits the panel's current formatting. */
  style?: Pick<Style, "textBold" | "textItalic" | "textUnderline" | "textAlign" | "textBgColor">,
): TextShape {
  return {
    id,
    kind: "text",
    x: point.x,
    y: point.y,
    text,
    color,
    fontSize,
    background: false,
    bold: style?.textBold ?? false,
    italic: style?.textItalic ?? false,
    underline: style?.textUnderline ?? false,
    align: style?.textAlign ?? "left",
    bgColor: style?.textBgColor ?? null,
  };
}
