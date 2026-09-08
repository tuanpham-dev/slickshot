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

/** Whether an element is on screen at `ms`.
 *
 * Half-open: an element ending at 2000ms is gone at exactly 2000ms, so two
 * elements that hand over at the same instant never both show for one frame.
 * An absent bound means "from the beginning" / "to the end".
 */
export function visibleAt(shape: Shape, ms: number): boolean {
  if (shape.startMs !== undefined && ms < shape.startMs) return false;
  if (shape.endMs !== undefined && ms >= shape.endMs) return false;
  return true;
}

/** One stretch of the clip over which the visible set of elements does not
 * change, and the elements visible during it. */
export interface OverlaySegment {
  startMs: number;
  endMs: number;
  shapes: Shape[];
}

/** Splits the clip into the fewest stretches over which the overlay is
 * constant.
 *
 * The backend composites one flattened image per frame, so time ranges are
 * handled by flattening once per *segment* rather than once per frame: the
 * only moments the overlay can change are the start and end times someone
 * actually set, so those are the cut points. A clip with no time ranges comes
 * back as a single segment, which is exactly what the old single-overlay path
 * did.
 */
export function overlaySegments(shapes: Shape[], durationMs: number): OverlaySegment[] {
  const drawn = shapesForOverlay(shapes);
  const end = Math.max(1, Math.round(durationMs));

  const cuts = new Set<number>([0, end]);
  for (const s of drawn) {
    for (const t of [s.startMs, s.endMs]) {
      // A bound outside the clip cannot split anything.
      if (t !== undefined && t > 0 && t < end) cuts.add(Math.round(t));
    }
  }
  const points = [...cuts].sort((a, b) => a - b);

  const out: OverlaySegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const startMs = points[i];
    const endMs = points[i + 1];
    if (endMs <= startMs) continue;
    out.push({
      startMs,
      endMs,
      // Sampled at the start of the segment: nothing changes inside one by
      // construction, so any instant in it gives the same answer.
      shapes: drawn.filter((s) => visibleAt(s, startMs)),
    });
  }
  return out;
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

    // Censors need no segmenting: they already travel as rects applied per
    // frame, so a time range is two more numbers on the rect.
    const when = {
      start_ms: shape.startMs !== undefined ? Math.round(shape.startMs) : null,
      end_ms: shape.endMs !== undefined ? Math.round(shape.endMs) : null,
    };
    const mode: CensorMode = shape.mode ?? "pixelate";
    if (mode === "solid") {
      out.push({ rect, ...when, kind: "solid", ...parseHex(shape.color) });
    } else if (mode === "blur") {
      // The editor expresses strength as a block size; the backend wants a
      // gaussian sigma. Half the block reads about the same on screen.
      const sigma = Math.min(MAX_SIGMA, Math.max(1, (shape.blockSize ?? DEFAULT_BLOCK) / 2));
      out.push({ rect, ...when, kind: "blur", sigma });
    } else {
      out.push({
        rect,
        ...when,
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

/** Magic matching `video.rs`'s `OVERLAY_MAGIC`. */
const OVERLAY_MAGIC = [0x53, 0x53, 0x4f, 0x56]; // "SSOV"

/** Packs several segment overlays into one raw IPC body.
 *
 * A command takes either a JSON payload or a raw one, never both, and the
 * JSON half already carries the export options -- so the overlays share the
 * raw body through this small container. A single whole-clip overlay is sent
 * as a bare PNG instead, which is what the backend's non-magic path reads and
 * what every export sent before time ranges existed looked like.
 */
export function packOverlays(segments: { startMs: number; endMs: number; png: Uint8Array }[]): Uint8Array {
  if (segments.length === 0) return new Uint8Array(0);

  const header = 4 + 4;
  const total =
    header + segments.reduce((n, s) => n + 8 + 8 + 4 + s.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(OVERLAY_MAGIC, 0);
  view.setUint32(4, segments.length, true);

  let at = header;
  for (const seg of segments) {
    view.setBigUint64(at, BigInt(Math.max(0, Math.round(seg.startMs))), true);
    view.setBigUint64(at + 8, BigInt(Math.max(0, Math.round(seg.endMs))), true);
    view.setUint32(at + 16, seg.png.length, true);
    out.set(seg.png, at + 20);
    at += 20 + seg.png.length;
  }
  return out;
}
