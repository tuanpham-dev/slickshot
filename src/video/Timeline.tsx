import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { clampTrim, formatTimecode, msToPx, pxToMs, type Trim } from "./trim";

interface TimelineProps {
  duration: number;
  current: number;
  trim: Trim;
  playing: boolean;
  onTrimChange: (trim: Trim) => void;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  /** When an element is selected and time-ranged, the span it is on screen
   * for -- shown as a second bar under the trim so both are visible at once.
   * `null` when nothing is selected. */
  elementRange?: { start: number; end: number } | null;
  onElementRangeChange?: (range: { start: number; end: number }) => void;
}

type Drag = "start" | "end" | "playhead" | "elStart" | "elEnd";

/** The scrubber: a track with the excluded ranges dimmed, two trim handles
 * and a playhead. No filmstrip -- decoding thumbnails for a long recording
 * costs more than it helps at this size. */
export function Timeline({
  duration,
  current,
  trim,
  playing,
  onTrimChange,
  onSeek,
  onTogglePlay,
  elementRange = null,
  onElementRangeChange,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const msAt = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      return pxToMs(clientX - el.getBoundingClientRect().left, el.clientWidth, duration);
    },
    [duration],
  );

  // Bound to the window rather than the handle: a fast drag outruns a small
  // target, and losing the pointer mid-trim leaves the handle stranded.
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const ms = msAt(e.clientX);
      if (drag === "playhead") {
        onSeek(ms);
      } else if (drag === "start") {
        onTrimChange(clampTrim({ ...trim, start: ms }, duration, "start"));
      } else if (drag === "end") {
        onTrimChange(clampTrim({ ...trim, end: ms }, duration, "end"));
      } else if (elementRange && onElementRangeChange) {
        // Reuses the trim clamp, so an element's bounds obey the same
        // minimum length and cannot cross each other either.
        const next =
          drag === "elStart"
            ? clampTrim({ ...elementRange, start: ms }, duration, "start")
            : clampTrim({ ...elementRange, end: ms }, duration, "end");
        onElementRangeChange(next);
      }
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, duration, msAt, onSeek, onTrimChange, trim, elementRange, onElementRangeChange]);

  const startPx = msToPx(trim.start, width, duration);
  const endPx = msToPx(trim.end, width, duration);
  const headPx = msToPx(current, width, duration);

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-t border-[var(--border)] bg-[var(--surface)]">
      <IconButton
        label={playing ? "Pause" : "Play"}
        icon={playing ? <Pause size={16} /> : <Play size={16} />}
        onClick={onTogglePlay}
      />
      <span className="text-[11px] font-mono text-[var(--fg-muted)] tabular-nums w-12 text-right">
        {formatTimecode(current)}
      </span>

      <div
        ref={trackRef}
        className="relative flex-1 h-8 rounded-[var(--radius-sm)] bg-[var(--surface-2,rgba(255,255,255,0.06))] cursor-pointer"
        onPointerDown={(e) => {
          onSeek(msAt(e.clientX));
          setDrag("playhead");
        }}
      >
        {/* Everything outside the trim is dimmed, so what will actually be
            exported reads at a glance. */}
        <div
          className="absolute inset-y-0 left-0 bg-black/45 rounded-l-[var(--radius-sm)] pointer-events-none"
          style={{ width: Math.max(0, startPx) }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-black/45 rounded-r-[var(--radius-sm)] pointer-events-none"
          style={{ width: Math.max(0, width - endPx) }}
        />

        <div
          role="slider"
          aria-label="Trim start"
          aria-valuenow={trim.start}
          aria-valuemin={0}
          aria-valuemax={duration}
          tabIndex={0}
          className="absolute inset-y-0 w-2 -ml-1 bg-[var(--accent)] rounded-sm cursor-ew-resize"
          style={{ left: startPx }}
          onPointerDown={(e) => {
            e.stopPropagation();
            setDrag("start");
          }}
        />
        <div
          role="slider"
          aria-label="Trim end"
          aria-valuenow={trim.end}
          aria-valuemin={0}
          aria-valuemax={duration}
          tabIndex={0}
          className="absolute inset-y-0 w-2 -ml-1 bg-[var(--accent)] rounded-sm cursor-ew-resize"
          style={{ left: endPx }}
          onPointerDown={(e) => {
            e.stopPropagation();
            setDrag("end");
          }}
        />

        {/* The selected element's own span, as a slim bar along the bottom
            of the same track -- a separate lane would double the timeline's
            height for something only visible while one element is selected. */}
        {elementRange && (
          <>
            <div
              className="absolute bottom-0 h-1.5 bg-[var(--warning,#e0a33b)] rounded-full pointer-events-none"
              style={{
                left: msToPx(elementRange.start, width, duration),
                width: Math.max(
                  2,
                  msToPx(elementRange.end, width, duration) -
                    msToPx(elementRange.start, width, duration),
                ),
              }}
            />
            <div
              role="slider"
              aria-label="Element start"
              aria-valuenow={elementRange.start}
              aria-valuemin={0}
              aria-valuemax={duration}
              tabIndex={0}
              className="absolute bottom-0 h-3 w-2 -ml-1 bg-[var(--warning,#e0a33b)] rounded-sm cursor-ew-resize"
              style={{ left: msToPx(elementRange.start, width, duration) }}
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag("elStart");
              }}
            />
            <div
              role="slider"
              aria-label="Element end"
              aria-valuenow={elementRange.end}
              aria-valuemin={0}
              aria-valuemax={duration}
              tabIndex={0}
              className="absolute bottom-0 h-3 w-2 -ml-1 bg-[var(--warning,#e0a33b)] rounded-sm cursor-ew-resize"
              style={{ left: msToPx(elementRange.end, width, duration) }}
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag("elEnd");
              }}
            />
          </>
        )}

        <div
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-[var(--fg)] pointer-events-none"
          style={{ left: headPx }}
        />
      </div>

      <span className="text-[11px] font-mono text-[var(--fg-muted)] tabular-nums w-12">
        {formatTimecode(duration)}
      </span>
    </div>
  );
}
