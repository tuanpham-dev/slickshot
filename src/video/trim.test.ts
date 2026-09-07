import { describe, expect, it } from "vitest";
import {
  clampTrim,
  formatTimecode,
  MIN_TRIM_MS,
  msToPx,
  outputDuration,
  pxToMs,
} from "./trim";

describe("clampTrim", () => {
  it("leaves a valid trim alone", () => {
    expect(clampTrim({ start: 1000, end: 4000 }, 10_000)).toEqual({
      start: 1000,
      end: 4000,
    });
  });

  it("holds both handles inside the clip", () => {
    expect(clampTrim({ start: -500, end: 99_000 }, 10_000)).toEqual({
      start: 0,
      end: 10_000,
    });
  });

  it("stops the handles crossing, pushing the one not being dragged", () => {
    // Dragging `end` back past `start`: the dragged handle keeps where the
    // user put it, and `start` is what gives way.
    const dragEnd = clampTrim({ start: 5000, end: 4900 }, 10_000, "end");
    expect(dragEnd.end).toBe(4900);
    expect(dragEnd.start).toBe(4900 - MIN_TRIM_MS);

    // Dragging `start` forward past `end`: now `start` holds and `end` moves.
    const dragStart = clampTrim({ start: 5000, end: 4900 }, 10_000, "start");
    expect(dragStart.start).toBe(5000);
    expect(dragStart.end).toBe(5000 + MIN_TRIM_MS);
  });

  it("keeps the minimum length inside the clip at the far end", () => {
    const trim = clampTrim({ start: 9990, end: 10_000 }, 10_000, "start");
    expect(trim.end).toBeLessThanOrEqual(10_000);
    expect(trim.end - trim.start).toBe(MIN_TRIM_MS);
  });

  it("gives up on the minimum for a clip shorter than it", () => {
    expect(clampTrim({ start: 0, end: 50 }, 50)).toEqual({ start: 0, end: 50 });
  });
});

describe("pixel mapping", () => {
  it("round-trips through the track width", () => {
    expect(msToPx(5000, 800, 10_000)).toBe(400);
    expect(pxToMs(400, 800, 10_000)).toBe(5000);
  });

  it("is safe on a zero-length clip or an unmeasured track", () => {
    expect(msToPx(100, 800, 0)).toBe(0);
    expect(pxToMs(100, 0, 10_000)).toBe(0);
  });

  it("clamps a drag past either end of the track", () => {
    expect(pxToMs(-50, 800, 10_000)).toBe(0);
    expect(pxToMs(9999, 800, 10_000)).toBe(10_000);
  });
});

describe("formatTimecode", () => {
  it("reads as m:ss for a short clip", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(9_000)).toBe("0:09");
    expect(formatTimecode(75_000)).toBe("1:15");
  });

  it("grows an hours field only when it needs one", () => {
    expect(formatTimecode(3_600_000)).toBe("1:00:00");
    expect(formatTimecode(3_725_000)).toBe("1:02:05");
  });
});

describe("outputDuration", () => {
  it("shortens with speed", () => {
    expect(outputDuration({ start: 0, end: 8000 }, 2)).toBe(4000);
    expect(outputDuration({ start: 0, end: 8000 }, 0.5)).toBe(16_000);
    expect(outputDuration({ start: 2000, end: 6000 }, 1)).toBe(4000);
  });
});
