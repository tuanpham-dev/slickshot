import type { ImgPoint, Shape, Style } from "../types";
import { createRect } from "./rect";
import { createEllipse } from "./ellipse";
import { createArrow } from "./arrow";
import { createHighlight } from "./highlight";
import { createPixelate } from "./pixelate";
import { createSpotlight } from "./spotlight";
import { createLoupe } from "./loupe";

/** Builds the in-progress shape for a drag-created tool. Shared by the
 * editor canvas and the capture overlay so the two cannot drift on what a
 * given tool draws. Returns null for tools that are not drag-created (text,
 * marker, stamp) or that draw nothing (select, crop, ocr). */
export function makeDraft(
  tool: string,
  start: ImgPoint,
  current: ImgPoint,
  style: Style,
  constrain: boolean,
  id = "draft",
): Shape | null {
  switch (tool) {
    case "rect":
      return createRect(id, start, current, style, constrain);
    case "ellipse":
      return createEllipse(id, start, current, style, constrain);
    // Line is the Arrow tool starting from the headless style: one shape,
    // one factory, and the head dropdown drives whichever tool is active.
    case "arrow":
    case "line":
      return createArrow(id, start, current, style, constrain);
    case "highlight":
      return createHighlight(id, start, current, style);
    case "pixelate":
      return createPixelate(id, start, current, style);
    case "spotlight":
      return createSpotlight(id, start, current, style);
    case "loupe":
      return createLoupe(id, start, current, style);
    default:
      return null;
  }
}
