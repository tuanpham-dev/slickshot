/** Pure timeline math for the video editor's scrubber. Split out from the
 * component so the clamping rules -- which are what stop a trim from
 * inverting or collapsing to nothing -- are testable without a DOM. */

/** Shortest clip a trim may leave behind. Below this an export produces a
 * file with one or two frames, which reads as a bug rather than a choice. */
export const MIN_TRIM_MS = 100;

export interface Trim {
  start: number;
  end: number;
}

/** Keeps a trim inside the clip, in order, and at least `MIN_TRIM_MS` long.
 * `moved` says which handle the user is dragging, so the *other* one is the
 * one that gives way when they collide. */
export function clampTrim(
  trim: Trim,
  duration: number,
  moved: "start" | "end" = "end",
): Trim {
  const limit = Math.max(0, duration);
  // A clip shorter than the minimum can't satisfy it; keep the whole thing
  // rather than returning something inverted.
  if (limit <= MIN_TRIM_MS) return { start: 0, end: limit };

  let start = Math.min(Math.max(0, trim.start), limit);
  let end = Math.min(Math.max(0, trim.end), limit);

  if (end - start < MIN_TRIM_MS) {
    if (moved === "start") {
      start = Math.min(start, limit - MIN_TRIM_MS);
      end = start + MIN_TRIM_MS;
    } else {
      end = Math.max(end, MIN_TRIM_MS);
      start = end - MIN_TRIM_MS;
    }
  }
  return { start, end };
}

export function msToPx(ms: number, width: number, duration: number): number {
  if (duration <= 0) return 0;
  return (ms / duration) * width;
}

export function pxToMs(px: number, width: number, duration: number): number {
  if (width <= 0) return 0;
  return Math.min(Math.max(0, (px / width) * duration), duration);
}

/** `m:ss` under an hour, `h:mm:ss` past it -- recordings are usually short,
 * and a leading `0:` on every one of them is noise. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = secs.toString().padStart(2, "0");
  if (hours > 0) return `${hours}:${mins.toString().padStart(2, "0")}:${ss}`;
  return `${mins}:${ss}`;
}

/** How long the export runs once speed is applied. */
export function outputDuration(trim: Trim, speed: number): number {
  return Math.max(0, trim.end - trim.start) / Math.max(0.01, speed);
}
