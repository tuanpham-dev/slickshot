import { describe, expect, it } from "vitest";
import { placeCluster, type SelectionFractions } from "./cluster";

const container = { w: 1000, h: 800 };
const size = { w: 200, h: 36 };
const MARGIN = 8;

function frac(left: number, top: number, right: number, bottom: number): SelectionFractions {
  return { left, top, right, bottom };
}

/** Fully on screen: neither the cluster's left nor right edge crosses the
 * monitor, and it sits within the vertical margins. */
function onScreen(p: { left: number; top: number }): boolean {
  return (
    p.left - size.w / 2 >= MARGIN - 0.001 &&
    p.left + size.w / 2 <= container.w - MARGIN + 0.001 &&
    p.top >= MARGIN - 0.001 &&
    p.top + size.h <= container.h - MARGIN + 0.001
  );
}

const CORNERS: [string, SelectionFractions][] = [
  ["top-left", frac(0, 0, 0.2, 0.2)],
  ["top-right", frac(0.8, 0, 1, 0.2)],
  ["bottom-left", frac(0, 0.8, 0.2, 1)],
  ["bottom-right", frac(0.8, 0.8, 1, 1)],
  ["full monitor", frac(0, 0, 1, 1)],
  ["full height, narrow", frac(0.45, 0, 0.55, 1)],
];

describe("placeCluster", () => {
  for (const prefer of ["above", "below"] as const) {
    for (const [name, sel] of CORNERS) {
      it(`keeps a ${prefer}-preferring cluster on screen for a ${name} selection`, () => {
        expect(onScreen(placeCluster(sel, container, size, prefer))).toBe(true);
      });
    }
  }

  it("sits below the selection when there is room and below is preferred", () => {
    const p = placeCluster(frac(0.4, 0.1, 0.6, 0.3), container, size, "below");
    expect(p.top).toBe(0.3 * container.h + 10);
  });

  it("sits above the selection when there is room and above is preferred", () => {
    const p = placeCluster(frac(0.4, 0.3, 0.6, 0.5), container, size, "above");
    expect(p.top).toBe(0.3 * container.h - size.h - 10);
  });

  it("falls back to the other side when the preferred one has no room", () => {
    // Selection hard against the top edge: an above-preferring cluster has
    // nowhere to go but below it.
    const p = placeCluster(frac(0.4, 0, 0.6, 0.2), container, size, "above");
    expect(p.top).toBe(0.2 * container.h + 10);
  });

  it("centres on the selection when it is comfortably inside", () => {
    const p = placeCluster(frac(0.4, 0.1, 0.6, 0.3), container, size, "below");
    expect(p.left).toBe(500);
  });

  it("clamps the centre so a selection at the left edge does not push it off", () => {
    const p = placeCluster(frac(0, 0.1, 0.05, 0.3), container, size, "below");
    expect(p.left).toBe(MARGIN + size.w / 2);
  });

  it("clamps the centre at the right edge too", () => {
    const p = placeCluster(frac(0.95, 0.1, 1, 0.3), container, size, "below");
    expect(p.left).toBe(container.w - MARGIN - size.w / 2);
  });

  it("still returns something on screen when the cluster is wider than the monitor", () => {
    // Degenerate but reachable with many tools configured on a small display:
    // the clamp must not invert and place it off the left edge.
    const wide = { w: 1400, h: 36 };
    const p = placeCluster(frac(0.4, 0.1, 0.6, 0.3), container, wide, "above");
    expect(p.left).toBe(MARGIN + wide.w / 2);
  });

  it("the two clusters do not overlap for a selection with room on both sides", () => {
    const sel = frac(0.3, 0.3, 0.7, 0.6);
    const bar = placeCluster(sel, container, size, "above");
    const actions = placeCluster(sel, container, size, "below", { top: bar.top, height: size.h });
    expect(bar.top + size.h).toBeLessThan(actions.top);
  });

  // Both clusters get forced onto the same side by a selection hugging an
  // edge; without stacking they land on exactly the same row.
  for (const [name, sel] of CORNERS) {
    it(`stacks the two clusters clear of each other for a ${name} selection`, () => {
      const bar = placeCluster(sel, container, size, "above");
      const actions = placeCluster(sel, container, size, "below", {
        top: bar.top,
        height: size.h,
      });
      const overlaps = actions.top < bar.top + size.h && bar.top < actions.top + size.h;
      expect(overlaps).toBe(false);
      expect(onScreen(bar)).toBe(true);
      expect(onScreen(actions)).toBe(true);
    });
  }

  it("leaves a non-colliding placement untouched", () => {
    const sel = frac(0.3, 0.3, 0.7, 0.6);
    const plain = placeCluster(sel, container, size, "below");
    const avoided = placeCluster(sel, container, size, "below", { top: 0, height: 20 });
    expect(avoided).toEqual(plain);
  });
});
