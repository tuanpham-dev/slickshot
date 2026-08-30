import type { PhysRect } from "../lib/geometry";
import type { Backdrop, Shape } from "./types";
import { preloadImageShapes, render } from "./render";
import { drawBackdrop } from "./tools/backdrop";

export interface FlattenOptions {
  /** Region of the image to export; null exports the whole image. */
  cropRect?: PhysRect | null;
  /** Frame composited around the result; ignored when `enabled` is false. */
  backdrop?: Backdrop | null;
  /** Explicit output size for the image, or null/undefined to keep its own
   * dimensions. Applied before the backdrop, so the number the user typed is
   * the size of the *picture* and any frame is added around it. */
  target?: { w: number; h: number } | null;
}

function resizeCanvas(source: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return out;
}

/** Composites the finished image: base bitmap + a freshly rendered
 * annotation layer, optionally cropped, wrapped in a backdrop and scaled.
 *
 * The annotation layer is re-rendered here rather than copied off the
 * on-screen canvas, because that one also carries editing chrome -- the
 * dashed selection outline, resize handles, and the crop/OCR region masks --
 * which used to get baked straight into exported PNGs. */
export async function flattenToPng(
  baseCanvas: HTMLCanvasElement,
  shapes: Shape[],
  opts: FlattenOptions = {},
): Promise<Uint8Array> {
  const { cropRect = null, backdrop = null, target = null } = opts;

  await preloadImageShapes(shapes);

  const annotations = document.createElement("canvas");
  annotations.width = baseCanvas.width;
  annotations.height = baseCanvas.height;
  render(annotations.getContext("2d")!, shapes, { baseImage: baseCanvas });

  const width = cropRect ? Math.round(cropRect.w) : baseCanvas.width;
  const height = cropRect ? Math.round(cropRect.h) : baseCanvas.height;
  const sx = cropRect ? cropRect.x : 0;
  const sy = cropRect ? cropRect.y : 0;

  let out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(baseCanvas, sx, sy, width, height, 0, 0, width, height);
  ctx.drawImage(annotations, sx, sy, width, height, 0, 0, width, height);

  if (target && (target.w !== out.width || target.h !== out.height)) {
    out = resizeCanvas(out, target.w, target.h);
  }
  if (backdrop?.enabled) out = drawBackdrop(out, backdrop);

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Failed to encode PNG");
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}
