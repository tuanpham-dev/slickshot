import { describe, expect, it } from "vitest";
import type { Shape } from "../editor/types";
import {
  extractCensors,
  hasEdits,
  overlaySegments,
  packOverlays,
  shapesForOverlay,
  VIDEO_TOOLS,
  visibleAt,
} from "./videoTools";

function censor(over: Partial<Extract<Shape, { kind: "pixelate" }>> = {}): Shape {
  return {
    id: "c1",
    kind: "pixelate",
    x: 10,
    y: 20,
    w: 30,
    h: 40,
    blockSize: 12,
    ...over,
  } as Shape;
}

function rect(): Shape {
  return {
    id: "r1",
    kind: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    style: { stroke: "#f00", fill: null, strokeWidth: 2, opacity: 1 },
  } as unknown as Shape;
}

describe("extractCensors", () => {
  it("reads a pixelate censor with its block size", () => {
    expect(extractCensors([censor()])).toEqual([
      {
        rect: { x: 10, y: 20, w: 30, h: 40 },
        start_ms: null,
        end_ms: null,
        kind: "pixelate",
        block: 12,
      },
    ]);
  });

  it("reads a solid censor's colour as separate channels", () => {
    const [c] = extractCensors([censor({ mode: "solid", color: "#ff8000" })]);
    expect(c).toEqual({
      rect: { x: 10, y: 20, w: 30, h: 40 },
      start_ms: null,
      end_ms: null,
      kind: "solid",
      r: 255,
      g: 128,
      b: 0,
    });
  });

  it("expands a three-digit hex", () => {
    const [c] = extractCensors([censor({ mode: "solid", color: "#0f0" })]);
    expect(c).toMatchObject({ r: 0, g: 255, b: 0 });
  });

  it("turns a blur censor's block size into a sigma", () => {
    const [c] = extractCensors([censor({ mode: "blur", blockSize: 10 })]);
    expect(c).toEqual({
      rect: { x: 10, y: 20, w: 30, h: 40 },
      start_ms: null,
      end_ms: null,
      kind: "blur",
      sigma: 5,
    });
  });

  it("clamps sigma so a huge block cannot make the export crawl", () => {
    const [c] = extractCensors([censor({ mode: "blur", blockSize: 400 })]);
    expect(c).toMatchObject({ sigma: 12 });
  });

  it("treats a shape with no mode as pixelate, the original behaviour", () => {
    const [c] = extractCensors([censor({ mode: undefined })]);
    expect(c).toMatchObject({ kind: "pixelate" });
  });

  it("normalises a rect dragged right-to-left", () => {
    // The editor stores the drag as-is, so w/h can be negative; a negative
    // width would clamp to nothing once it reached Rust.
    const [c] = extractCensors([censor({ x: 100, y: 100, w: -40, h: -20 })]);
    expect(c.rect).toEqual({ x: 60, y: 80, w: 40, h: 20 });
  });

  it("drops a zero-area censor rather than sending it", () => {
    expect(extractCensors([censor({ w: 0 })])).toEqual([]);
  });

  it("ignores every other kind of shape", () => {
    expect(extractCensors([rect()])).toEqual([]);
  });

  it("keeps several censors in order", () => {
    const shapes = [censor({ x: 1 }), rect(), censor({ x: 2, mode: "solid" })];
    const out = extractCensors(shapes);
    expect(out).toHaveLength(2);
    expect(out[0].rect.x).toBe(1);
    expect(out[1].rect.x).toBe(2);
  });
});

describe("shapesForOverlay", () => {
  it("keeps annotations and drops censors", () => {
    // Censors must not be baked into the overlay: one flattened image over a
    // moving clip would freeze the censored pixels at one frame.
    const shapes = [rect(), censor()];
    const out = shapesForOverlay(shapes);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("rect");
  });

  it("returns an empty list for censors alone", () => {
    expect(shapesForOverlay([censor()])).toEqual([]);
  });
});

describe("VIDEO_TOOLS", () => {
  it("offers crop and the drawing tools", () => {
    expect(VIDEO_TOOLS).toContain("crop");
    expect(VIDEO_TOOLS).toContain("rect");
    expect(VIDEO_TOOLS).toContain("pixelate");
  });

  it("leaves out the tools that read pixels from a still frame", () => {
    for (const id of ["eyedropper", "ocr", "loupe", "measure", "spotlight"]) {
      expect(VIDEO_TOOLS).not.toContain(id);
    }
  });
});

describe("hasEdits", () => {
  it("is false for an untouched clip", () => {
    expect(hasEdits([], null, 1)).toBe(false);
  });

  it("is true once anything is drawn, cropped or sped up", () => {
    expect(hasEdits([rect()], null, 1)).toBe(true);
    expect(hasEdits([], { x: 0, y: 0, w: 10, h: 10 }, 1)).toBe(true);
    expect(hasEdits([], null, 2)).toBe(true);
  });
});

function timed(id: string, startMs?: number, endMs?: number): Shape {
  return { ...(rect() as object), id, startMs, endMs } as Shape;
}

describe("visibleAt", () => {
  it("shows an element with no bounds for the whole clip", () => {
    const s = timed("a");
    expect(visibleAt(s, 0)).toBe(true);
    expect(visibleAt(s, 999999)).toBe(true);
  });

  it("respects a start time", () => {
    const s = timed("a", 1000);
    expect(visibleAt(s, 999)).toBe(false);
    expect(visibleAt(s, 1000)).toBe(true);
  });

  it("treats the end as exclusive", () => {
    // Half-open, so two elements handing over at the same instant never
    // both show for a frame.
    const s = timed("a", 0, 2000);
    expect(visibleAt(s, 1999)).toBe(true);
    expect(visibleAt(s, 2000)).toBe(false);
  });

  it("handles a bounded window", () => {
    const s = timed("a", 1000, 2000);
    expect(visibleAt(s, 500)).toBe(false);
    expect(visibleAt(s, 1500)).toBe(true);
    expect(visibleAt(s, 2500)).toBe(false);
  });
});

describe("overlaySegments", () => {
  it("gives one segment when nothing is time-ranged", () => {
    // The old single-overlay behaviour, unchanged.
    const segs = overlaySegments([timed("a"), timed("b")], 5000);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startMs: 0, endMs: 5000 });
    expect(segs[0].shapes).toHaveLength(2);
  });

  it("cuts at each bound and carries the right shapes", () => {
    const segs = overlaySegments([timed("a", 1000, 3000), timed("b", 2000)], 5000);
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
      [3000, 5000],
    ]);
    expect(segs[0].shapes.map((s) => s.id)).toEqual([]);
    expect(segs[1].shapes.map((s) => s.id)).toEqual(["a"]);
    expect(segs[2].shapes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(segs[3].shapes.map((s) => s.id)).toEqual(["b"]);
  });

  it("does not cut on a bound outside the clip", () => {
    const segs = overlaySegments([timed("a", 0, 99999)], 5000);
    expect(segs).toHaveLength(1);
  });

  it("collapses two elements sharing a bound into one cut", () => {
    const segs = overlaySegments([timed("a", 2000), timed("b", 2000)], 4000);
    expect(segs).toHaveLength(2);
    expect(segs[1].shapes).toHaveLength(2);
  });

  it("leaves censors out -- they travel as rects, not pixels", () => {
    const segs = overlaySegments([censor(), timed("a")], 3000);
    expect(segs[0].shapes.map((s) => s.kind)).toEqual(["rect"]);
  });

  it("never emits an empty or inverted segment", () => {
    for (const segs of [
      overlaySegments([timed("a", 0, 0)], 1000),
      overlaySegments([timed("a", 1000, 1000)], 1000),
      overlaySegments([], 0),
    ]) {
      for (const seg of segs) expect(seg.endMs).toBeGreaterThan(seg.startMs);
    }
  });
});

describe("extractCensors with time ranges", () => {
  it("carries the bounds through", () => {
    const [c] = extractCensors([censor({ startMs: 500, endMs: 1500 })]);
    expect(c).toMatchObject({ start_ms: 500, end_ms: 1500 });
  });

  it("sends nulls for an unbounded censor", () => {
    const [c] = extractCensors([censor()]);
    expect(c).toMatchObject({ start_ms: null, end_ms: null });
  });
});

describe("packOverlays", () => {
  it("sends nothing when there is nothing to send", () => {
    expect(packOverlays([]).length).toBe(0);
  });

  it("writes the magic, the count and each segment", () => {
    const body = packOverlays([
      { startMs: 0, endMs: 1000, png: new Uint8Array([1, 2, 3]) },
      { startMs: 1000, endMs: 4000, png: new Uint8Array([9]) },
    ]);
    expect([...body.slice(0, 4)]).toEqual([0x53, 0x53, 0x4f, 0x56]);
    const view = new DataView(body.buffer);
    expect(view.getUint32(4, true)).toBe(2);
    expect(Number(view.getBigUint64(8, true))).toBe(0);
    expect(Number(view.getBigUint64(16, true))).toBe(1000);
    expect(view.getUint32(24, true)).toBe(3);
    expect([...body.slice(28, 31)]).toEqual([1, 2, 3]);
    // Second segment starts right after the first one's bytes.
    expect(Number(view.getBigUint64(31, true))).toBe(1000);
  });

  it("rounds fractional times rather than writing NaN", () => {
    const body = packOverlays([
      { startMs: 12.7, endMs: 99.2, png: new Uint8Array([0]) },
    ]);
    const view = new DataView(body.buffer);
    expect(Number(view.getBigUint64(8, true))).toBe(13);
    expect(Number(view.getBigUint64(16, true))).toBe(99);
  });
});
