import { formatColor, toHex, type ColorFormat, type Rgb } from "../lib/color";

const SIZE = 132;
/** Source pixels sampled across the loupe's width (odd, so one pixel is
 * exactly centered under the crosshair). */
export const SAMPLE_PX = 11;
const CURSOR_GAP = 24;

interface PixelLoupeProps {
  /** Canvases composited into the magnified view, painted in order -- the
   * editor passes its base bitmap plus the annotation layer so the loupe
   * shows what's actually on screen, not just the untouched screenshot. */
  sources: (HTMLCanvasElement | null)[];
  /** Top-left of the sampled neighborhood, in source-canvas pixels. */
  sourceX: number;
  sourceY: number;
  /** Cursor position, in the coordinate space `fixed` selects. */
  cssX: number;
  cssY: number;
  containerWidth: number;
  containerHeight: number;
  color: Rgb | null;
  format: ColorFormat;
  caption: string;
  /** `true` positions against the viewport (editor), `false` against the
   * nearest positioned ancestor (overlay, which fills its monitor). */
  fixed?: boolean;
}

/** Pixel-level magnifier that follows the cursor: an N×N neighborhood blown
 * up with a crosshair on the center pixel, plus a color readout. Drawn as a
 * plain scaled `drawImage` with smoothing off, so what it shows is exactly
 * the underlying pixels. */
export function PixelLoupe({
  sources,
  sourceX,
  sourceY,
  cssX,
  cssY,
  containerWidth,
  containerHeight,
  color,
  format,
  caption,
  fixed = false,
}: PixelLoupeProps) {
  // Flip to whichever side of the cursor has room, so the loupe never hangs
  // off the edge (where it would be clipped away entirely).
  const left = cssX + CURSOR_GAP + SIZE > containerWidth ? cssX - CURSOR_GAP - SIZE : cssX + CURSOR_GAP;
  const top = cssY + CURSOR_GAP + SIZE > containerHeight ? cssY - CURSOR_GAP - SIZE : cssY + CURSOR_GAP;
  const zoom = SIZE / SAMPLE_PX;

  return (
    <div
      className={[
        fixed ? "fixed" : "absolute",
        "z-50 pointer-events-none rounded-[var(--radius-md)] overflow-hidden",
        "border border-[var(--border)] shadow-[var(--shadow-lg)] bg-[var(--surface)]",
      ].join(" ")}
      style={{ left, top, width: SIZE }}
    >
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <canvas
          width={SIZE}
          height={SIZE}
          style={{ imageRendering: "pixelated", display: "block" }}
          ref={(el) => {
            if (!el) return;
            const ctx = el.getContext("2d")!;
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, SIZE, SIZE);
            for (const source of sources) {
              if (source) ctx.drawImage(source, sourceX, sourceY, SAMPLE_PX, SAMPLE_PX, 0, 0, SIZE, SIZE);
            }
          }}
        />
        <div
          className="absolute border-2 border-[var(--accent)]"
          style={{
            left: ((SAMPLE_PX - 1) / 2) * zoom,
            top: ((SAMPLE_PX - 1) / 2) * zoom,
            width: zoom,
            height: zoom,
          }}
        />
      </div>
      <div className="px-2 py-1.5 flex flex-col gap-0.5 border-t border-[var(--border)]">
        <div className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-[2px] border border-[var(--border)] shrink-0"
            style={{ background: color ? toHex(color) : "transparent" }}
          />
          <span className="text-[11px] font-mono text-[var(--fg)] truncate">
            {color ? formatColor(color, format) : "—"}
          </span>
        </div>
        <span className="text-[10px] font-mono text-[var(--fg-muted)]">{caption}</span>
      </div>
    </div>
  );
}
