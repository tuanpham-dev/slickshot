import { useCallback, useEffect, useRef, useState } from "react";
import { Scissors, Snowflake, ZoomIn, FastForward, X } from "lucide-react";
import type { VideoEffect } from "./timelinePlan";
import { msToPx, pxToMs } from "./trim";

/** How each kind reads on the timeline. Colour carries the meaning at a
 * glance, which matters more here than anywhere else in the editor: several
 * clips share a lane and the labels are tiny. */
const STYLE: Record<
  VideoEffect["kind"],
  { bg: string; icon: React.ReactNode; label: (e: VideoEffect) => string }
> = {
  cut: {
    bg: "repeating-linear-gradient(45deg,#b4483f,#b4483f 6px,#8f342d 6px,#8f342d 12px)",
    icon: <Scissors size={11} />,
    label: (e) => `${((e.endMs - e.startMs) / 1000).toFixed(1)}s`,
  },
  freeze: {
    bg: "#7c6ce0",
    icon: <Snowflake size={11} />,
    label: (e) => (e.kind === "freeze" ? `${(e.holdMs / 1000).toFixed(1)}s` : ""),
  },
  speed: {
    bg: "#2f9e8f",
    icon: <FastForward size={11} />,
    label: (e) => (e.kind === "speed" ? `${e.rate}×` : ""),
  },
  zoom: {
    bg: "#3b6fe0",
    icon: <ZoomIn size={11} />,
    label: () => "Zoom",
  },
};

/** Packs clips into as few rows as possible without overlapping.
 *
 * Effects are not assigned a fixed lane: two that never overlap in time share
 * a row, so a clip with several short effects does not grow a row per effect.
 */
export function packLanes(effects: VideoEffect[]): VideoEffect[][] {
  const lanes: VideoEffect[][] = [];
  for (const e of [...effects].sort((a, b) => a.startMs - b.startMs)) {
    const start = e.startMs;
    const lane = lanes.find((row) => {
      const last = row[row.length - 1];
      const lastEnd = last.kind === "freeze" ? last.startMs : last.endMs;
      // A freeze occupies an instant, so `>=` would let a second one at the
      // same moment share the row and hide underneath the first.
      if (last.kind === "freeze" || e.kind === "freeze") return start > lastEnd;
      return start >= lastEnd;
    });
    if (lane) lane.push(e);
    else lanes.push([e]);
  }
  return lanes;
}

export interface EffectLanesProps {
  duration: number;
  effects: VideoEffect[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (effect: VideoEffect) => void;
  onRemove: (id: string) => void;
}

type Drag = { id: string; edge: "start" | "end" | "move"; grabMs: number };

/** The lanes of timeline effects under the scrubber. */
export function EffectLanes({
  duration,
  effects,
  selectedId,
  onSelect,
  onChange,
  onRemove,
}: EffectLanesProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);

  // A callback ref, not an effect on mount: this component renders nothing
  // until the first effect exists, so an effect keyed on `[]` would run while
  // the element was still absent and never measure anything -- leaving every
  // clip stacked at zero.
  const attach = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
  }, []);

  const msAt = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return 0;
      return pxToMs(clientX - el.getBoundingClientRect().left, el.clientWidth, duration);
    },
    [duration],
  );

  // Window-bound, like the trim handles: a fast drag outruns a small target.
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const effect = effects.find((x) => x.id === drag!.id);
      if (!effect) return;
      const ms = Math.max(0, Math.min(duration, msAt(e.clientX)));
      if (drag!.edge === "move") {
        const span = effect.endMs - effect.startMs;
        const start = Math.max(0, Math.min(duration - span, ms - drag!.grabMs));
        onChange({ ...effect, startMs: start, endMs: start + span });
      } else if (drag!.edge === "start") {
        onChange({ ...effect, startMs: Math.min(ms, effect.endMs - 1) });
      } else {
        onChange({ ...effect, endMs: Math.max(ms, effect.startMs + 1) });
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
  }, [drag, duration, effects, msAt, onChange]);

  const lanes = packLanes(effects);
  if (lanes.length === 0) return null;

  return (
    <div ref={attach} className="relative flex flex-col gap-1 px-3 pb-2">
      {lanes.map((lane, i) => (
        <div key={i} className="relative h-6">
          {lane.map((effect) => {
            const style = STYLE[effect.kind];
            const left = msToPx(effect.startMs, width, duration);
            // A freeze has no source span, so it gets a fixed readable width
            // rather than collapsing to a hairline.
            const raw =
              effect.kind === "freeze"
                ? 56
                : msToPx(effect.endMs, width, duration) - left;
            const w = Math.max(36, raw);
            const selected = effect.id === selectedId;
            return (
              <div
                key={effect.id}
                className={`absolute top-0 h-6 rounded-[var(--radius-sm)] flex items-center gap-1 px-1.5 text-[10px] font-semibold text-white select-none cursor-grab ${
                  selected ? "ring-2 ring-white/80" : ""
                }`}
                style={{ left, width: w, background: style.bg }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(effect.id);
                  setDrag({
                    id: effect.id,
                    edge: "move",
                    grabMs: msAt(e.clientX) - effect.startMs,
                  });
                }}
                title={`${effect.kind} · ${style.label(effect)}`}
              >
                {style.icon}
                <span className="truncate">{style.label(effect)}</span>

                {effect.kind !== "freeze" && (
                  <>
                    <span
                      role="slider"
                      aria-label={`${effect.kind} start`}
                      aria-valuenow={effect.startMs}
                      aria-valuemin={0}
                      aria-valuemax={duration}
                      tabIndex={0}
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/30 rounded-l-[var(--radius-sm)]"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onSelect(effect.id);
                        setDrag({ id: effect.id, edge: "start", grabMs: 0 });
                      }}
                    />
                    <span
                      role="slider"
                      aria-label={`${effect.kind} end`}
                      aria-valuenow={effect.endMs}
                      aria-valuemin={0}
                      aria-valuemax={duration}
                      tabIndex={0}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/30 rounded-r-[var(--radius-sm)]"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onSelect(effect.id);
                        setDrag({ id: effect.id, edge: "end", grabMs: 0 });
                      }}
                    />
                  </>
                )}

                {selected && (
                  <button
                    type="button"
                    aria-label={`Remove ${effect.kind}`}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--bg)] text-[var(--fg)] border border-[var(--border)] flex items-center justify-center"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(effect.id);
                    }}
                  >
                    <X size={9} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
