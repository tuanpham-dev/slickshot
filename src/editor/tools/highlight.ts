import type { OcrWordBox } from "../../lib/ipc";
import type { HighlightShape, ImgPoint, Style } from "../types";

export function createHighlight(id: string, start: ImgPoint, current: ImgPoint, style: Style): HighlightShape {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    id,
    kind: "highlight",
    x,
    y,
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
    color: style.stroke,
  };
}

/** One line of text assembled from OCR word boxes. */
export interface TextLine {
  x: number;
  y: number;
  w: number;
  h: number;
  words: OcrWordBox[];
}

/** Groups word boxes into lines by vertical overlap.
 *
 * Words are sorted top-to-bottom then left-to-right first, so a line is
 * built from a contiguous run and its words stay in reading order -- which
 * is what lets `snapHighlightToLines` span from the first intersected word
 * to the last rather than merely bounding them. */
export function clusterWordsToLines(boxes: OcrWordBox[]): TextLine[] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextLine[] = [];

  for (const box of sorted) {
    // Compared against the shorter box so a capital or a descender doesn't
    // split one visual line into two.
    const line = lines.find((l) => {
      const overlap = Math.min(l.y + l.h, box.y + box.h) - Math.max(l.y, box.y);
      return overlap > Math.min(l.h, box.h) * 0.5;
    });
    if (line) {
      const right = Math.max(l_right(line), box.x + box.w);
      const bottom = Math.max(line.y + line.h, box.y + box.h);
      line.x = Math.min(line.x, box.x);
      line.y = Math.min(line.y, box.y);
      line.w = right - line.x;
      line.h = bottom - line.y;
      line.words.push(box);
    } else {
      lines.push({ x: box.x, y: box.y, w: box.w, h: box.h, words: [box] });
    }
  }

  for (const line of lines) line.words.sort((a, b) => a.x - b.x);
  return lines;
}

function l_right(line: TextLine): number {
  return line.x + line.w;
}

/** Turns a rough drag into one highlight rect per line of text it crosses,
 * each spanning only the words actually covered -- so a sloppy swipe across
 * two sentences produces two tight highlights instead of one loose box.
 *
 * Returns an empty array when the drag crosses no text; the caller falls
 * back to the freeform rect in that case rather than dropping the gesture. */
export function snapHighlightToLines(
  drag: { x: number; y: number; w: number; h: number },
  lines: TextLine[],
  pad = 2,
): { x: number; y: number; w: number; h: number }[] {
  const dragRight = drag.x + drag.w;
  const dragBottom = drag.y + drag.h;
  const out: { x: number; y: number; w: number; h: number }[] = [];

  for (const line of lines) {
    const verticalOverlap = Math.min(line.y + line.h, dragBottom) - Math.max(line.y, drag.y);
    if (verticalOverlap <= 0) continue;

    const covered = line.words.filter((word) => word.x < dragRight && word.x + word.w > drag.x);
    if (covered.length === 0) continue;

    const left = Math.min(...covered.map((w) => w.x));
    const right = Math.max(...covered.map((w) => w.x + w.w));
    out.push({ x: left - pad, y: line.y - pad, w: right - left + pad * 2, h: line.h + pad * 2 });
  }

  return out;
}
