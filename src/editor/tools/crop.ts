import type { HandleId, ImgPoint, RectHandleId } from "../types";
import type { PhysRect } from "../../lib/geometry";
import { resizeBounds } from "./select";

const MIN_CROP_SIZE = 10;

export function createCropRect(start: ImgPoint, current: ImgPoint, imageWidth: number, imageHeight: number): PhysRect {
  const x = Math.max(0, Math.min(start.x, current.x));
  const y = Math.max(0, Math.min(start.y, current.y));
  const right = Math.min(imageWidth, Math.max(start.x, current.x));
  const bottom = Math.min(imageHeight, Math.max(start.y, current.y));
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

function clampRect(r: PhysRect, imageWidth: number, imageHeight: number): PhysRect {
  const w = Math.min(Math.max(MIN_CROP_SIZE, r.w), imageWidth);
  const h = Math.min(Math.max(MIN_CROP_SIZE, r.h), imageHeight);
  const x = Math.min(Math.max(0, r.x), imageWidth - w);
  const y = Math.min(Math.max(0, r.y), imageHeight - h);
  return { x, y, w, h };
}

/** Resizes the crop rect from one of its 8 handles, clamped to stay within
 * the image and never shrink below `MIN_CROP_SIZE`. */
export function resizeCropRect(
  orig: PhysRect,
  handle: HandleId,
  point: ImgPoint,
  imageWidth: number,
  imageHeight: number,
): PhysRect {
  const clampedPoint = {
    x: Math.min(Math.max(0, point.x), imageWidth),
    y: Math.min(Math.max(0, point.y), imageHeight),
  };
  const next = resizeBounds(orig, handle as RectHandleId, clampedPoint, false);
  return clampRect(next, imageWidth, imageHeight);
}

/** Drags the whole crop rect by (dx, dy), clamped to stay within the image. */
export function moveCropRect(orig: PhysRect, dx: number, dy: number, imageWidth: number, imageHeight: number): PhysRect {
  const x = Math.min(Math.max(0, orig.x + dx), imageWidth - orig.w);
  const y = Math.min(Math.max(0, orig.y + dy), imageHeight - orig.h);
  return { ...orig, x, y };
}
