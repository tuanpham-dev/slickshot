import type { ImageShape } from "../types";

/** Largest fraction of the canvas an inserted image may occupy on drop --
 * pasting a full-screen screenshot into another screenshot should land as a
 * manageable, draggable object, not cover the whole canvas. */
const MAX_FRACTION = 0.6;

/** Places `dataUrl` centered on the canvas at its natural size, scaled down
 * (never up) to fit within `MAX_FRACTION` of the canvas on both axes. */
export function createImageShape(
  id: string,
  dataUrl: string,
  naturalWidth: number,
  naturalHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): ImageShape {
  const scale = Math.min(
    (canvasWidth * MAX_FRACTION) / naturalWidth,
    (canvasHeight * MAX_FRACTION) / naturalHeight,
    1,
  );
  const w = Math.max(1, Math.round(naturalWidth * scale));
  const h = Math.max(1, Math.round(naturalHeight * scale));
  return {
    id,
    kind: "image",
    x: Math.round((canvasWidth - w) / 2),
    y: Math.round((canvasHeight - h) / 2),
    w,
    h,
    dataUrl,
  };
}

/** Reads an image blob (from a paste event or a file) as a data URL. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read image data"));
    reader.readAsDataURL(blob);
  });
}
