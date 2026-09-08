import { describe, expect, it } from "vitest";
import {
  buildPlan,
  isCut,
  mapToOutput,
  mapToSource,
  zoomAt,
  type VideoEffect,
} from "./timelinePlan";
import { packLanes } from "./EffectLanes";

const trim = { start: 0, end: 10_000 };

function cut(startMs: number, endMs: number): VideoEffect {
  return { id: "c", kind: "cut", startMs, endMs };
}
function speed(startMs: number, endMs: number, rate: number): VideoEffect {
  return { id: "s", kind: "speed", startMs, endMs, rate };
}
function freeze(startMs: number, holdMs: number): VideoEffect {
  return { id: "f", kind: "freeze", startMs, endMs: startMs, holdMs };
}

describe("buildPlan", () => {
  it("passes a plain clip straight through", () => {
    const plan = buildPlan(trim, []);
    expect(plan.segments).toHaveLength(1);
    expect(plan.outDurationMs).toBe(10_000);
    expect(plan.segments[0]).toMatchObject({ srcStartMs: 0, srcEndMs: 10_000, rate: 1 });
  });

  it("applies the editor's global speed", () => {
    expect(buildPlan(trim, [], 2).outDurationMs).toBe(5_000);
    expect(buildPlan(trim, [], 0.5).outDurationMs).toBe(20_000);
  });

  it("starts the output at zero however late the trim starts", () => {
    // What you exported should begin at 0, not at the trim's offset.
    const plan = buildPlan({ start: 4_000, end: 6_000 }, []);
    expect(plan.segments[0].outStartMs).toBe(0);
    expect(plan.outDurationMs).toBe(2_000);
  });

  describe("cut", () => {
    it("removes the range and pulls everything after it earlier", () => {
      const plan = buildPlan(trim, [cut(3_000, 5_000)]);
      expect(plan.outDurationMs).toBe(8_000);
      expect(mapToOutput(plan, 2_000)).toBeCloseTo(2_000);
      expect(mapToOutput(plan, 4_000)).toBeNull();
      // 6s of source is 2s past the cut's start, so it lands at 4s out.
      expect(mapToOutput(plan, 6_000)).toBeCloseTo(4_000);
    });

    it("handles a cut at the very start", () => {
      const plan = buildPlan(trim, [cut(0, 2_000)]);
      expect(plan.outDurationMs).toBe(8_000);
      expect(mapToOutput(plan, 0)).toBeNull();
      expect(mapToOutput(plan, 2_000)).toBeCloseTo(0);
    });

    it("handles two cuts", () => {
      const plan = buildPlan(trim, [
        { ...cut(1_000, 2_000), id: "a" },
        { ...cut(5_000, 7_000), id: "b" },
      ]);
      expect(plan.outDurationMs).toBe(7_000);
    });

    it("cutting everything leaves an empty output rather than a negative one", () => {
      const plan = buildPlan(trim, [cut(0, 10_000)]);
      expect(plan.outDurationMs).toBe(0);
      expect(plan.segments).toHaveLength(0);
    });
  });

  describe("speed", () => {
    it("compresses only its own range", () => {
      // 0-2s at 1x, 2-6s at 2x (so 2s), 6-10s at 1x => 8s.
      const plan = buildPlan(trim, [speed(2_000, 6_000, 2)]);
      expect(plan.outDurationMs).toBe(8_000);
      expect(mapToOutput(plan, 2_000)).toBeCloseTo(2_000);
      expect(mapToOutput(plan, 4_000)).toBeCloseTo(3_000);
      expect(mapToOutput(plan, 6_000)).toBeCloseTo(4_000);
    });

    it("stretches for a rate below one", () => {
      const plan = buildPlan(trim, [speed(0, 2_000, 0.5)]);
      expect(plan.outDurationMs).toBe(12_000);
    });

    it("wins over the global speed inside its range", () => {
      // What the clip on the timeline says is what you get -- the two do not
      // multiply, which would make 2x on top of 2x mean 4x.
      const plan = buildPlan(trim, [speed(0, 10_000, 2)], 2);
      expect(plan.outDurationMs).toBe(5_000);
    });

    it("refuses a rate low enough to make the export unbounded", () => {
      const plan = buildPlan(trim, [speed(0, 10_000, 0)]);
      expect(plan.outDurationMs).toBeLessThanOrEqual(200_000);
    });
  });

  describe("freeze", () => {
    it("adds its hold to the duration without consuming source", () => {
      const plan = buildPlan(trim, [freeze(4_000, 2_000)]);
      expect(plan.outDurationMs).toBe(12_000);
      // Everything after the freeze is pushed later by the hold.
      expect(mapToOutput(plan, 4_000)).toBeCloseTo(6_000);
      expect(mapToOutput(plan, 3_999)).toBeCloseTo(3_999);
    });

    it("shows the frozen moment for the whole hold", () => {
      const plan = buildPlan(trim, [freeze(4_000, 2_000)]);
      expect(mapToSource(plan, 4_500)).toBeCloseTo(4_000);
      expect(mapToSource(plan, 5_900)).toBeCloseTo(4_000);
      expect(mapToSource(plan, 6_100)).toBeCloseTo(4_100);
    });

    it("ignores a zero-length hold", () => {
      expect(buildPlan(trim, [freeze(4_000, 0)]).outDurationMs).toBe(10_000);
    });
  });

  it("combines a cut, a speed and a freeze", () => {
    // 0-2 @1x = 2s; 2-4 cut; 4-6 @2x = 1s; freeze 1s at 6; 6-10 @1x = 4s.
    const plan = buildPlan(trim, [
      cut(2_000, 4_000),
      speed(4_000, 6_000, 2),
      freeze(6_000, 1_000),
    ]);
    expect(plan.outDurationMs).toBe(8_000);
    expect(mapToOutput(plan, 1_000)).toBeCloseTo(1_000);
    expect(mapToOutput(plan, 3_000)).toBeNull();
    expect(mapToOutput(plan, 5_000)).toBeCloseTo(2_500);
    expect(mapToOutput(plan, 8_000)).toBeCloseTo(6_000);
  });
});

describe("mapToOutput", () => {
  it("never goes backwards as source time advances", () => {
    const plan = buildPlan(trim, [
      cut(2_000, 3_000),
      speed(5_000, 7_000, 3),
      freeze(8_000, 500),
    ]);
    let last = -1;
    for (let t = 0; t <= 10_000; t += 50) {
      const out = mapToOutput(plan, t);
      if (out === null) continue;
      expect(out).toBeGreaterThanOrEqual(last - 1e-6);
      last = out;
    }
  });

  it("maps the trim's final instant to the end of the output", () => {
    const plan = buildPlan(trim, []);
    expect(mapToOutput(plan, 10_000)).toBeCloseTo(10_000);
  });
});

describe("mapToSource", () => {
  it("round-trips through mapToOutput on an untouched clip", () => {
    const plan = buildPlan(trim, []);
    for (const t of [0, 1_234, 9_999]) {
      expect(mapToSource(plan, mapToOutput(plan, t)!)).toBeCloseTo(t);
    }
  });

  it("returns null past the end", () => {
    expect(mapToSource(buildPlan(trim, []), 99_999)).toBeNull();
  });
});

describe("zoomAt and isCut", () => {
  const zoom: VideoEffect = {
    id: "z",
    kind: "zoom",
    startMs: 1_000,
    endMs: 3_000,
    rect: { x: 10, y: 20, w: 100, h: 80 },
  };

  it("reports the zoom only inside its range", () => {
    expect(zoomAt([zoom], 999)).toBeNull();
    expect(zoomAt([zoom], 1_000)).toEqual({ x: 10, y: 20, w: 100, h: 80 });
    expect(zoomAt([zoom], 3_000)).toBeNull();
  });

  it("lets a later zoom win where they overlap", () => {
    const other: VideoEffect = { ...zoom, id: "z2", rect: { x: 0, y: 0, w: 5, h: 5 } };
    expect(zoomAt([zoom, other], 2_000)).toEqual({ x: 0, y: 0, w: 5, h: 5 });
  });

  it("reports cut ranges", () => {
    expect(isCut([cut(1_000, 2_000)], 1_500)).toBe(true);
    expect(isCut([cut(1_000, 2_000)], 2_000)).toBe(false);
  });
});

describe("packLanes", () => {
  it("puts non-overlapping effects on one row", () => {
    const rows = packLanes([cut(0, 1_000), cut(2_000, 3_000)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
  });

  it("gives overlapping effects their own rows", () => {
    const rows = packLanes([cut(0, 3_000), speed(1_000, 2_000, 2)]);
    expect(rows).toHaveLength(2);
  });

  it("keeps each row in time order", () => {
    const rows = packLanes([cut(4_000, 5_000), cut(0, 1_000)]);
    expect(rows[0].map((e) => e.startMs)).toEqual([0, 4_000]);
  });

  it("stacks freezes rather than piling them at one point", () => {
    // A freeze has no width in source time, so packing has to treat it as
    // occupying an instant or two at the same moment would overlap invisibly.
    const rows = packLanes([freeze(2_000, 500), freeze(2_000, 800)]);
    expect(rows).toHaveLength(2);
  });

  it("returns nothing for no effects", () => {
    expect(packLanes([])).toEqual([]);
  });
});
