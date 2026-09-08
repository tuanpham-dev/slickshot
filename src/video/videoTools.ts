import type { CensorMode, Shape, ToolId } from "../editor/types";
import type { Censor } from "../lib/ipc";

/** Tools the Video Editor offers.
 *
 * A deliberate subset of the image editor's set. Left out: the ones that read
 * pixels from a still (`eyedropper`, `ocr`, `loupe`, `measure`), which have no
 * meaning against a clip whose pixels change under them, and `spotlight`,
 * which dims everything outside a region -- an effect that would have to be
 * burnt into every frame to be honest about what it hides.
 */
export const VIDEO_TOOLS: ToolId[] = [
  "select",
  "crop",
  "rect",
  "ellipse",
  "arrow",
  "line",
  "freehand",
  "text",
  "highlight",
  "marker",
  "pixelate",
  "stamp",
];

/** Default block size for a censor whose shape predates the field. */
const DEFAULT_BLOCK = 12;
/** Matches `record::transform::MAX_BLUR_SIGMA`; a larger radius costs more
 * than it hides. */
const MAX_SIGMA = 12;

function parseHex(color: string | undefined): { r: number; g: number; b: number } {
  const hex = (color ?? "#000000").replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Normalises a rect that may have been dragged right-to-left or bottom-to-top
 * -- the editor stores whatever the drag produced, and a negative width would
 * silently clamp to nothing on the Rust side. */
function normalise(x: number, y: number, w: number, h: number) {
  return {
    x: Math.round(Math.min(x, x + w)),
    y: Math.round(Math.min(y, y + h)),
    w: Math.round(Math.abs(w)),
    h: Math.round(Math.abs(h)),
  };
}

/** The censor shapes, as the per-frame `Censor` list the backend applies.
 *
 * These cannot travel in the flattened overlay PNG like other annotations: an
 * overlay is one image composited onto every frame, so a censor baked from a
 * single paused frame would show that frame's pixels forever while the video
 * moved underneath it. They are re-applied per frame instead.
 */
export function extractCensors(shapes: Shape[]): Censor[] {
  const out: Censor[] = [];
  for (const shape of shapes) {
    if (shape.kind !== "pixelate") continue;
    const rect = normalise(shape.x, shape.y, shape.w, shape.h);
    if (rect.w <= 0 || rect.h <= 0) continue;

    const mode: CensorMode = shape.mode ?? "pixelate";
    if (mode === "solid") {
      out.push({ rect, kind: "solid", ...parseHex(shape.color) });
    } else if (mode === "blur") {
      // The editor expresses strength as a block size; the backend wants a
      // gaussian sigma. Half the block reads about the same on screen.
      const sigma = Math.min(MAX_SIGMA, Math.max(1, (shape.blockSize ?? DEFAULT_BLOCK) / 2));
      out.push({ rect, kind: "blur", sigma });
    } else {
      out.push({
        rect,
        kind: "pixelate",
        block: Math.max(2, Math.round(shape.blockSize ?? DEFAULT_BLOCK)),
      });
    }
  }
  return out;
}

/** Everything that *can* be flattened into a single overlay image: every
 * annotation except the censors, which `extractCensors` handles per frame. */
export function shapesForOverlay(shapes: Shape[]): Shape[] {
  return shapes.filter((s) => s.kind !== "pixelate");
}

/** Whether anything about this export changes the source pixels. Used to skip
 * a pointless re-encode when the answer is "no". */
export function hasEdits(
  shapes: Shape[],
  crop: { x: number; y: number; w: number; h: number } | null,
  speed: number,
): boolean {
  return shapes.length > 0 || crop !== null || Math.abs(speed - 1) > 1e-6;
}
