import type { OcrWordBox } from "../../lib/ipc";

/** A run of adjacent words on one line that matched a PII pattern. */
export interface RedactMatch {
  kind: "email" | "phone" | "card" | "key";
  x: number;
  y: number;
  w: number;
  h: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Well-known credential prefixes. Matching on shape alone produces far too
 * many false positives (any long hex string -- a commit SHA, a CSS color
 * list, a UUID -- would qualify), so a recognized prefix is required. */
const KEY_PREFIXES = [
  "sk-",
  "pk-",
  "sk_live_",
  "sk_test_",
  "pk_live_",
  "pk_test_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "AKIA",
  "ASIA",
  "AIza",
  "ya29.",
  "glpat-",
  "npm_",
  "hf_",
];

/** Strips the separators a human would type inside a number or key so the
 * digit/character tests below see the underlying value. */
function digitsOf(text: string): string {
  return text.replace(/[^0-9]/g, "");
}

/** Trailing punctuation ends a sentence, not the value: "call 555-0142."
 * should still match. Leading punctuation covers "(555)" style groupings. */
function trimPunctuation(text: string): string {
  return text.replace(/^[([{<"'“‘]+/, "").replace(/[)\]}>"'”’.,;:!?]+$/, "");
}

function isEmail(text: string): boolean {
  return EMAIL.test(trimPunctuation(text));
}

function isApiKey(text: string): boolean {
  const t = trimPunctuation(text);
  if (t.length < 20) return false;
  return KEY_PREFIXES.some((p) => t.startsWith(p));
}

/** Luhn checksum -- what separates a real card number from any 16-digit
 * string (an order number, a serial, a phone with an extension). */
export function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A phone number is 7-15 digits with at least one separator or a leading
 * `+`. The separator requirement is what keeps plain long integers (years,
 * counts, IDs) out. */
function isPhone(text: string): boolean {
  const t = trimPunctuation(text);
  if (!/^\+?[\d().\- ]+$/.test(t)) return false;
  const digits = digitsOf(t);
  if (digits.length < 7 || digits.length > 15) return false;
  return t.startsWith("+") || /[().\- ]/.test(t);
}

/** Words are on the same text line when their vertical spans mostly overlap.
 * Compared against the shorter box's height so a tall glyph (a capital or a
 * descender) doesn't split a line in two. */
function sameLine(a: OcrWordBox, b: OcrWordBox): boolean {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = bottom - top;
  return overlap > Math.min(a.h, b.h) * 0.5;
}

function union(boxes: OcrWordBox[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Finds personally-identifying values among OCR'd words and returns one box
 * per match, ready to be turned into censor shapes.
 *
 * Card numbers and phone numbers are frequently split across several word
 * boxes ("4111 1111 1111 1111" is four words to the OCR engine), so runs of
 * up to four adjacent same-line numeric words are tested together as well as
 * individually, longest run first -- a full card number should win over the
 * 4-digit group inside it that might coincidentally look like a phone. */
export function findPii(boxes: OcrWordBox[]): RedactMatch[] {
  const matches: RedactMatch[] = [];
  const claimed = new Set<number>();

  const claim = (indices: number[], kind: RedactMatch["kind"]) => {
    if (indices.some((i) => claimed.has(i))) return false;
    indices.forEach((i) => claimed.add(i));
    matches.push({ kind, ...union(indices.map((i) => boxes[i])) });
    return true;
  };

  // Multi-word numeric runs first, longest first, so a grouped card number
  // isn't pre-empted by one of its own 4-digit groups.
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= boxes.length; i++) {
      const run = boxes.slice(i, i + len);
      if (!run.every((b, k) => k === 0 || sameLine(run[k - 1], b))) continue;
      const joined = run.map((b) => b.text).join("");
      if (!/^[+\d().\- ]+$/.test(joined)) continue;

      const digits = digitsOf(joined);
      const indices = Array.from({ length: len }, (_, k) => i + k);
      if (passesLuhn(digits)) {
        claim(indices, "card");
      } else if (digits.length >= 7 && digits.length <= 15) {
        claim(indices, "phone");
      }
    }
  }

  boxes.forEach((box, i) => {
    if (claimed.has(i)) return;
    const t = trimPunctuation(box.text);
    if (isEmail(box.text)) claim([i], "email");
    else if (isApiKey(box.text)) claim([i], "key");
    else if (passesLuhn(digitsOf(t)) && /^[\d\- ]+$/.test(t)) claim([i], "card");
    else if (isPhone(box.text)) claim([i], "phone");
  });

  // Reading order, so the shapes are added top-to-bottom rather than in the
  // order the run-length passes happened to find them.
  return matches.sort((a, b) => a.y - b.y || a.x - b.x);
}
