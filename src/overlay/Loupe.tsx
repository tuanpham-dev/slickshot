import type { PhysPoint } from "../lib/geometry";
import { PixelLoupe, SAMPLE_PX } from "../ui/PixelLoupe";
import type { ColorFormat, Rgb } from "../lib/color";
export { COLOR_FORMATS, formatColor, type ColorFormat, type Rgb } from "../lib/color";

/** Reads one pixel out of the frozen frame canvas. `point` is in the global
 * virtual-screen space; `monitorOrigin` is this monitor's top-left, since
 * the canvas holds only this monitor's pixels. */
export function samplePixel(
  canvas: HTMLCanvasElement | null,
  point: PhysPoint,
  monitorOrigin: PhysPoint,
): Rgb | null {
  if (!canvas) return null;
  const x = point.x - monitorOrigin.x;
  const y = point.y - monitorOrigin.y;
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  const data = canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
  return { r: data[0], g: data[1], b: data[2] };
}

interface LoupeProps {
  /** The frozen frame for this monitor -- source of the magnified pixels. */
  frameCanvas: HTMLCanvasElement | null;
  /** Cursor position in global virtual-screen space. */
  point: PhysPoint;
  monitorOrigin: PhysPoint;
  /** CSS-pixel position of the cursor inside the overlay container. */
  cssX: number;
  cssY: number;
  containerWidth: number;
  containerHeight: number;
  color: Rgb | null;
  format: ColorFormat;
  /** Extra line under the color readout (e.g. a measurement). */
  caption?: string;
}

/** The overlay's magnifier: converts virtual-screen coordinates into this
 * monitor's frame pixels, then defers to the shared `PixelLoupe`. */
export function Loupe({
  frameCanvas,
  point,
  monitorOrigin,
  cssX,
  cssY,
  containerWidth,
  containerHeight,
  color,
  format,
  caption,
}: LoupeProps) {
  const half = (SAMPLE_PX - 1) / 2;
  return (
    <PixelLoupe
      sources={[frameCanvas]}
      sourceX={point.x - monitorOrigin.x - half}
      sourceY={point.y - monitorOrigin.y - half}
      cssX={cssX}
      cssY={cssY}
      containerWidth={containerWidth}
      containerHeight={containerHeight}
      color={color}
      format={format}
      caption={caption ?? `${point.x}, ${point.y}`}
    />
  );
}
