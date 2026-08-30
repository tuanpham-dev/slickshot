import type { AppSettings, ConfirmDest } from "../lib/ipc";

/** How a confirmed capture leaves the overlay.
 *
 * - `"plain"` -- nothing was drawn, so Rust composites the region from the
 *   frozen session exactly as it always has.
 * - `"editor"` -- the capture is heading for the editor, so the annotations
 *   travel as shapes and stay editable there.
 * - `"flattened"` -- anything else bakes them into the PNG, because nothing
 *   downstream can render a shape list. */
export type ConfirmRoute = "plain" | "editor" | "flattened";

/** Flattening a capture that is about to open in the editor would hand the
 * user pixels they cannot select -- and since `post_capture` defaults to
 * `editor`, that is the *common* path for the Confirm button, not an edge
 * case. Copy and Save name their own destination and always flatten: neither
 * the clipboard nor a PNG on disk can hold a shape list. */
export function confirmRoute(
  dest: ConfirmDest,
  postCapture: AppSettings["post_capture"],
  hasAnnotations: boolean,
): ConfirmRoute {
  if (!hasAnnotations) return "plain";
  if (dest === "default" && postCapture === "editor") return "editor";
  return "flattened";
}
