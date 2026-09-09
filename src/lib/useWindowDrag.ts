import { useCallback, useRef } from "react";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";

/** Makes an undecorated window draggable by one of its elements.
 *
 * Not `data-tauri-drag-region`, which is the obvious way and did not work
 * here: that attribute has to be on the element the press actually lands on
 * (the handler tests the event's own target rather than walking up), and it
 * hands the drag to the window server, which makes it untestable and left the
 * recording pill stuck wherever it first appeared.
 *
 * This moves the window itself on each pointer move instead. Pointer capture
 * keeps the drag alive once the cursor leaves the window -- which it does
 * immediately, because the window is moving out from under it.
 */
export function useWindowDrag() {
  const anchor = useRef<{ x: number; y: number; winX: number; winY: number } | null>(null);

  const onPointerDown = useCallback(async (e: React.PointerEvent) => {
    // Left button only: a right-click drag should not move the window.
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    try {
      const position = await getCurrentWindow().outerPosition();
      anchor.current = {
        // Screen coordinates, so the reference frame does not move with the
        // window we are about to move.
        x: e.screenX * window.devicePixelRatio,
        y: e.screenY * window.devicePixelRatio,
        winX: position.x,
        winY: position.y,
      };
      target.setPointerCapture(e.pointerId);
    } catch {
      anchor.current = null;
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const start = anchor.current;
    if (!start) return;
    const dx = e.screenX * window.devicePixelRatio - start.x;
    const dy = e.screenY * window.devicePixelRatio - start.y;
    void getCurrentWindow().setPosition(
      new PhysicalPosition(Math.round(start.winX + dx), Math.round(start.winY + dy)),
    );
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    anchor.current = null;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };
}
