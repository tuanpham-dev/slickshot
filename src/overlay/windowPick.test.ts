import { describe, expect, it } from "vitest";
import type { WindowInfo } from "../lib/ipc";
import { windowAt } from "./windowPick";

function win(id: number, x: number, y: number, w: number, h: number): WindowInfo {
  return { id, title: `w${id}`, app_name: "app", rect: { x, y, w, h } };
}

describe("windowAt", () => {
  it("returns nothing when the point is over no window", () => {
    expect(windowAt([win(1, 0, 0, 10, 10)], { x: 50, y: 50 })).toBeNull();
  });

  it("picks the frontmost window, not the smallest", () => {
    // The regression: a small window *behind* a large front one used to win
    // for being small, so the picker highlighted something hidden.
    const front = win(1, 0, 0, 1000, 1000);
    const behind = win(2, 100, 100, 50, 50);
    expect(windowAt([front, behind], { x: 120, y: 120 })?.id).toBe(1);
  });

  it("picks the small window when it is genuinely in front", () => {
    const small = win(2, 100, 100, 50, 50);
    const big = win(1, 0, 0, 1000, 1000);
    expect(windowAt([small, big], { x: 120, y: 120 })?.id).toBe(2);
  });

  it("skips a front window that does not contain the point", () => {
    const front = win(1, 0, 0, 10, 10);
    const behind = win(2, 100, 100, 200, 200);
    expect(windowAt([front, behind], { x: 150, y: 150 })?.id).toBe(2);
  });

  it("handles an empty list", () => {
    expect(windowAt([], { x: 0, y: 0 })).toBeNull();
  });
});
