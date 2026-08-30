import type { PhysPoint, PhysRect } from "../lib/geometry";
import { rectContains } from "../lib/geometry";
import type { HandleId } from "./resize";

/** What a press on the overlay means. Selection and annotation share one
 * pointer surface, so this decision is kept pure and tested rather than
 * living inline in the handler -- getting the priority wrong silently breaks
 * gestures that have always worked. */
export type PointerIntent = "resize" | "draw" | "pick-shape" | "move" | "new-selection";

export interface PointerContext {
  /** The live selection, or null when nothing is selected yet. */
  selection: PhysRect | null;
  /** The armed annotation tool, or null when the overlay is in plain
   * selection mode. */
  activeTool: string | null;
  /** The resize handle under the pointer, if any -- resolved by the caller,
   * which owns the hit tolerance. */
  handle: HandleId | null;
}

/** Priority, highest first:
 *
 * 1. A handle always resizes. Handles sit on the selection's edge, so a press
 *    there is unambiguous and must not be stolen by drawing.
 * 2. Inside the selection with the select tool armed, pick a shape.
 * 3. Inside the selection with any other tool armed, draw. This is the whole
 *    point of arming a tool, and it outranks moving.
 * 4. Inside the selection with no tool, move it.
 * 5. Anything else starts a new selection -- including a press outside the
 *    selection with a tool armed, because outside the region the overlay is
 *    still a region picker.
 *
 * With `activeTool: null` the result is exactly what the overlay did before
 * annotation existed -- `"draw"` and `"pick-shape"` are unreachable, which
 * the tests assert. */
export function pointerIntent(point: PhysPoint, ctx: PointerContext): PointerIntent {
  if (ctx.selection && ctx.handle) return "resize";
  if (ctx.selection && rectContains(ctx.selection, point)) {
    if (ctx.activeTool === "select") return "pick-shape";
    return ctx.activeTool ? "draw" : "move";
  }
  return "new-selection";
}
