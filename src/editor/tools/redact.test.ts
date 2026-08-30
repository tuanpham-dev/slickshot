import { describe, expect, it } from "vitest";
import { findPii, passesLuhn } from "./redact";
import type { OcrWordBox } from "../../lib/ipc";

/** Lays words out on one horizontal line so `sameLine` groups them. */
function line(words: string[], y = 100): OcrWordBox[] {
  let x = 0;
  return words.map((text) => {
    const box = { text, x, y, w: text.length * 10, h: 18 };
    x += box.w + 6;
    return box;
  });
}

describe("passesLuhn", () => {
  it("accepts known-good test card numbers", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(passesLuhn("5500005555555559")).toBe(true);
    expect(passesLuhn("378282246310005")).toBe(true);
  });

  it("rejects numbers that fail the checksum or are the wrong length", () => {
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(passesLuhn("1234")).toBe(false);
    expect(passesLuhn("41111111111111111111")).toBe(false);
  });
});

describe("findPii", () => {
  it("finds an email address", () => {
    const matches = findPii(line(["Contact", "sam@example.com", "today"]));
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("email");
  });

  it("ignores ordinary prose", () => {
    expect(findPii(line(["The", "quick", "brown", "fox", "jumps"]))).toHaveLength(0);
  });

  it("finds a phone number with separators", () => {
    const matches = findPii(line(["Call", "555-018-2341", "now"]));
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("phone");
  });

  it("does not treat a bare long number as a phone", () => {
    expect(findPii(line(["Order", "18002339", "shipped"]))).toHaveLength(0);
  });

  it("finds a card number split across four word boxes", () => {
    const matches = findPii(line(["4111", "1111", "1111", "1111"]));
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("card");
    // The box must span every group, not just the first.
    expect(matches[0].w).toBeGreaterThan(100);
  });

  it("rejects a 16-digit run that fails Luhn", () => {
    const matches = findPii(line(["1234", "5678", "9012", "3456"]));
    expect(matches.every((m) => m.kind !== "card")).toBe(true);
  });

  it("finds prefixed API keys and ignores lookalike hex", () => {
    const key = findPii(line(["token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"]));
    expect(key).toHaveLength(1);
    expect(key[0].kind).toBe("key");

    // A commit SHA is the same shape but has no credential prefix.
    expect(findPii(line(["commit", "9f2b1c4e8a7d6f5b3c2a1e0d9f8b7a6c5d4e3f2a"]))).toHaveLength(0);
  });

  it("tolerates trailing sentence punctuation", () => {
    const matches = findPii(line(["Email", "sam@example.com,", "or", "call"]));
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("email");
  });

  it("does not join words that sit on different lines", () => {
    const first = line(["4111", "1111"], 100);
    const second = line(["1111", "1111"], 400);
    const matches = findPii([...first, ...second]);
    expect(matches.every((m) => m.kind !== "card")).toBe(true);
  });

  it("returns matches in reading order", () => {
    const boxes = [...line(["sam@example.com"], 300), ...line(["amy@example.com"], 100)];
    const matches = findPii(boxes);
    expect(matches).toHaveLength(2);
    expect(matches[0].y).toBeLessThan(matches[1].y);
  });
});
