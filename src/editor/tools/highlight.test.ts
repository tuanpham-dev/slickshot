import { describe, expect, it } from "vitest";
import { clusterWordsToLines, snapHighlightToLines } from "./highlight";
import type { OcrWordBox } from "../../lib/ipc";

/** Words laid out left-to-right on one baseline. */
function line(words: string[], y: number, startX = 0): OcrWordBox[] {
  let x = startX;
  return words.map((text) => {
    const box = { text, x, y, w: text.length * 10, h: 18 };
    x += box.w + 6;
    return box;
  });
}

describe("clusterWordsToLines", () => {
  it("groups words that share a baseline into one line", () => {
    const lines = clusterWordsToLines(line(["the", "quick", "brown"], 100));
    expect(lines).toHaveLength(1);
    expect(lines[0].words.map((w) => w.text)).toEqual(["the", "quick", "brown"]);
  });

  it("separates words on different baselines", () => {
    const lines = clusterWordsToLines([...line(["first"], 100), ...line(["second"], 140)]);
    expect(lines).toHaveLength(2);
  });

  it("keeps a tall glyph on the same line as its neighbours", () => {
    // A capital letter box is taller but still mostly overlapping.
    const boxes: OcrWordBox[] = [
      { text: "Tall", x: 0, y: 96, w: 40, h: 24 },
      { text: "rest", x: 46, y: 100, w: 40, h: 18 },
    ];
    expect(clusterWordsToLines(boxes)).toHaveLength(1);
  });

  it("returns words in reading order regardless of input order", () => {
    const words = line(["a", "b", "c"], 100);
    const shuffled = [words[2], words[0], words[1]];
    expect(clusterWordsToLines(shuffled)[0].words.map((w) => w.text)).toEqual(["a", "b", "c"]);
  });

  it("bounds a line across all of its words", () => {
    const [l] = clusterWordsToLines(line(["one", "two"], 100));
    expect(l.x).toBe(0);
    expect(l.x + l.w).toBe(66); // "one" 30 + gap 6 + "two" 30
  });

  it("handles an empty input", () => {
    expect(clusterWordsToLines([])).toEqual([]);
  });
});

describe("snapHighlightToLines", () => {
  const lines = clusterWordsToLines([...line(["alpha", "beta", "gamma"], 100), ...line(["delta", "epsilon"], 140)]);

  it("returns nothing when the drag crosses no text", () => {
    expect(snapHighlightToLines({ x: 0, y: 400, w: 100, h: 20 }, lines)).toEqual([]);
  });

  it("snaps to the line's own height, not the drag's", () => {
    const [rect] = snapHighlightToLines({ x: 0, y: 95, w: 40, h: 60 }, lines, 0);
    expect(rect.y).toBe(100);
    expect(rect.h).toBe(18);
  });

  it("spans only the words the drag actually covers", () => {
    // "alpha" occupies x 0..50; the drag stops inside it, so only it matches.
    const [rect] = snapHighlightToLines({ x: 0, y: 100, w: 30, h: 18 }, lines, 0);
    expect(rect.x).toBe(0);
    expect(rect.w).toBe(50);
  });

  it("produces one rect per line for a drag spanning two lines", () => {
    const rects = snapHighlightToLines({ x: 0, y: 100, w: 200, h: 60 }, lines, 0);
    expect(rects).toHaveLength(2);
    expect(rects[0].y).toBe(100);
    expect(rects[1].y).toBe(140);
  });

  it("applies the padding outward on both axes", () => {
    const [rect] = snapHighlightToLines({ x: 0, y: 100, w: 30, h: 18 }, lines, 2);
    expect(rect.x).toBe(-2);
    expect(rect.y).toBe(98);
    expect(rect.h).toBe(22);
  });
});
