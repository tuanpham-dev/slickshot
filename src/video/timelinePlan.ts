/** Effects that live on the timeline as their own clips, rather than as
 * properties of an annotation.
 *
 * Three of them -- cut, freeze and speed -- change how long the output is and
 * where each source moment lands in it. That makes the mapping from source
 * time to output time piecewise rather than a single divide, which is what
 * `buildPlan` produces. Zoom and censor do not move anything in time; they
 * only change what a frame looks like while they are active.
 */
export type VideoEffect =
  | { id: string; kind: "cut"; startMs: number; endMs: number }
  /** Holds the frame at `startMs` still for `holdMs` of output. */
  | { id: string; kind: "freeze"; startMs: number; endMs: number; holdMs: number }
  | { id: string; kind: "speed"; startMs: number; endMs: number; rate: number }
  /** Punches in to `rect` (source pixels) for the duration. */
  | {
      id: string;
      kind: "zoom";
      startMs: number;
      endMs: number;
      rect: { x: number; y: number; w: number; h: number };
    };

export type EffectKind = VideoEffect["kind"];

/** One stretch of the clip that plays at a constant rate, and where it lands
 * in the output.
 *
 * A freeze is a segment with no source span (`srcStartMs === srcEndMs`) and a
 * positive output span: one source moment stretched over output time. Cuts
 * produce no segment at all -- they are simply absent, which is what makes
 * everything after them shift earlier.
 */
export interface PlanSegment {
  srcStartMs: number;
  srcEndMs: number;
  outStartMs: number;
  outEndMs: number;
  /** Playback multiplier for this stretch; 0 for a freeze. */
  rate: number;
}

export interface TimelinePlan {
  segments: PlanSegment[];
  outDurationMs: number;
}

const EPS = 1e-6;

/** Every moment the behaviour can change: the trim's ends and each effect
 * bound that falls inside it. */
function cutPoints(
  trim: { start: number; end: number },
  effects: VideoEffect[],
): number[] {
  const points = new Set<number>([trim.start, trim.end]);
  for (const e of effects) {
    for (const t of [e.startMs, e.endMs]) {
      if (t > trim.start && t < trim.end) points.add(Math.round(t));
    }
  }
  return [...points].sort((a, b) => a - b);
}

function covers(e: VideoEffect, from: number, to: number): boolean {
  // A segment lies wholly inside or outside every effect by construction, so
  // testing the midpoint is enough and avoids boundary ambiguity.
  const mid = (from + to) / 2;
  return mid >= e.startMs && mid < e.endMs;
}

/**
 * Turns the trim and the timeline effects into an ordered source→output map.
 *
 * `globalSpeed` is the editor's own speed control and applies wherever no
 * speed effect does; a speed effect wins inside its own range rather than
 * multiplying with it, so what the clip on the timeline says is what you get.
 */
export function buildPlan(
  trim: { start: number; end: number },
  effects: VideoEffect[],
  globalSpeed = 1,
): TimelinePlan {
  const timing = effects.filter(
    (e) => e.kind === "cut" || e.kind === "speed" || e.kind === "freeze",
  );
  const points = cutPoints(trim, timing);

  const segments: PlanSegment[] = [];
  let out = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to - from < EPS) continue;

    // A freeze anchored here holds before the segment plays, so the frozen
    // moment is the one you parked on.
    for (const e of timing) {
      if (e.kind === "freeze" && Math.abs(e.startMs - from) < 0.5 && e.holdMs > 0) {
        segments.push({
          srcStartMs: from,
          srcEndMs: from,
          outStartMs: out,
          outEndMs: out + e.holdMs,
          rate: 0,
        });
        out += e.holdMs;
      }
    }

    if (timing.some((e) => e.kind === "cut" && covers(e, from, to))) continue;

    const speed = timing.find((e) => e.kind === "speed" && covers(e, from, to));
    const rate = Math.max(
      0.05,
      speed && speed.kind === "speed" ? speed.rate : globalSpeed,
    );
    const outLen = (to - from) / rate;
    segments.push({
      srcStartMs: from,
      srcEndMs: to,
      outStartMs: out,
      outEndMs: out + outLen,
      rate,
    });
    out += outLen;
  }

  return { segments, outDurationMs: Math.round(out) };
}

/** Where a source moment lands in the output, or `null` when it was cut. */
export function mapToOutput(plan: TimelinePlan, srcMs: number): number | null {
  for (const seg of plan.segments) {
    if (seg.rate === 0) continue; // a freeze consumes no source span
    if (srcMs >= seg.srcStartMs && srcMs < seg.srcEndMs) {
      return seg.outStartMs + (srcMs - seg.srcStartMs) / seg.rate;
    }
  }
  // The very last instant of the trim belongs to the final segment.
  const last = [...plan.segments].reverse().find((s) => s.rate > 0);
  if (last && Math.abs(srcMs - last.srcEndMs) < 0.5) return last.outEndMs;
  return null;
}

/** Which source moment an output moment shows -- what a fixed-rate encoder
 * (the GIF path) needs to walk its own timeline. */
export function mapToSource(plan: TimelinePlan, outMs: number): number | null {
  for (const seg of plan.segments) {
    if (outMs >= seg.outStartMs && outMs < seg.outEndMs) {
      if (seg.rate === 0) return seg.srcStartMs;
      return seg.srcStartMs + (outMs - seg.outStartMs) * seg.rate;
    }
  }
  return null;
}

/** The zoom active at a source moment, if any. Later effects win, so a zoom
 * drawn over another behaves like the top one. */
export function zoomAt(
  effects: VideoEffect[],
  srcMs: number,
): { x: number; y: number; w: number; h: number } | null {
  let found: VideoEffect | null = null;
  for (const e of effects) {
    if (e.kind === "zoom" && srcMs >= e.startMs && srcMs < e.endMs) found = e;
  }
  return found && found.kind === "zoom" ? found.rect : null;
}

/** Whether a moment survives to the output at all -- used to grey the cut
 * stretches on the timeline and to skip them while previewing. */
export function isCut(effects: VideoEffect[], srcMs: number): boolean {
  return effects.some((e) => e.kind === "cut" && srcMs >= e.startMs && srcMs < e.endMs);
}
