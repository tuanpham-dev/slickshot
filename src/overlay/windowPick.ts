import { rectContains, type PhysPoint } from "../lib/geometry";
import type { WindowInfo } from "../lib/ipc";

/** The window under a point: the frontmost one containing it.
 *
 * `listWindows` returns front-to-back order -- that is what every backend's
 * enumeration already gives (CGWindowList on macOS, EnumWindows on Windows,
 * the X stacking order on Linux) -- so the first match is the one actually
 * visible there.
 *
 * This used to pick the *smallest* match instead, on the theory that a small
 * window inside a big one is the more specific answer. It is not: a small
 * window sitting *behind* a large one won purely for being small, so the
 * picker highlighted windows you could not see.
 */
export function windowAt(windows: WindowInfo[], p: PhysPoint): WindowInfo | null {
  return windows.find((w) => rectContains(w.rect, p)) ?? null;
}
