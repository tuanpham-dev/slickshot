import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { X } from "lucide-react";
import { fetchShotImage, pinReady, pinClose, frontendMounted } from "../lib/ipc";

interface PinWindowProps {
  params: URLSearchParams;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3.0;
const WHEEL_STEP = 0.1;

export function PinWindow({ params }: PinWindowProps) {
  const imageId = params.get("image");
  const label = params.get("label");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const [hovering, setHovering] = useState(false);
  // Manual drag-to-move via setPosition deltas, not the native
  // startDragging() handshake -- that relies on the window manager honoring
  // an interactive-move request (_NET_WM_MOVERESIZE / gtk_window_begin_move_drag),
  // which isn't reliably supported for undecorated windows on every WM. This
  // is driven entirely by our own pointer tracking + setPosition calls, so
  // it works the same regardless of WM support.
  const dragRef = useRef<{ screenX: number; screenY: number; winX: number; winY: number; scale: number } | null>(
    null,
  );
  // Guards the async outerPosition()/scaleFactor() fetch kicked off at
  // pointerdown: if the pointer is released before that resolves, this
  // stops the resolved data from populating `dragRef` and starting a drag
  // no pointerup will ever clear.
  const activePointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    frontendMounted();
    if (!imageId || !label) return;
    let stale = false;
    fetchShotImage(imageId)
      .then((bitmap) => {
        if (stale) return;
        naturalSizeRef.current = { w: bitmap.width, h: bitmap.height };
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        pinReady(label);
      })
      .catch((err) => {
        console.error("pin image load failed", err);
        if (!stale) pinClose(label);
      });
    return () => {
      stale = true;
    };
  }, [imageId, label]);

  useEffect(() => {
    if (!label) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") pinClose(label!);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [label]);

  useEffect(() => {
    if (!label) return;
    async function onWheel(e: WheelEvent) {
      e.preventDefault();
      const natural = naturalSizeRef.current;
      if (!natural) return;
      const window_ = getCurrentWindow();
      const current = await window_.innerSize();
      const currentScale = current.width / natural.w;
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, currentScale + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)),
      );
      await window_.setSize(
        new PhysicalSize(Math.round(natural.w * nextScale), Math.round(natural.h * nextScale)),
      );
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [label]);

  if (!imageId || !label) {
    return null;
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    // Capture must be set synchronously, in the same tick as the native
    // pointerdown -- deferring it behind the async outerPosition()/
    // scaleFactor() IPC round trips below meant the browser/webview no
    // longer reliably associated the capture with this gesture, which is
    // why dragging silently did nothing.
    (e.target as Element).setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;

    const pointerId = e.pointerId;
    const startScreenX = e.screenX;
    const startScreenY = e.screenY;
    const window_ = getCurrentWindow();
    Promise.all([window_.outerPosition(), window_.scaleFactor()]).then(([pos, scale]) => {
      if (activePointerIdRef.current !== pointerId) return; // released before this resolved
      dragRef.current = { screenX: startScreenX, screenY: startScreenY, winX: pos.x, winY: pos.y, scale };
    });
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.screenX - drag.screenX) * drag.scale;
    const dy = (e.screenY - drag.screenY) * drag.scale;
    getCurrentWindow().setPosition(
      new PhysicalPosition(Math.round(drag.winX + dx), Math.round(drag.winY + dy)),
    );
  }

  function handlePointerUp(e: React.PointerEvent) {
    activePointerIdRef.current = null;
    dragRef.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }

  return (
    <div
      className="relative w-screen h-screen overflow-hidden outline outline-1 outline-[var(--border)] -outline-offset-1 cursor-move"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={() => pinClose(label)}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
      {hovering && (
        <button
          type="button"
          aria-label="Close pin"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => pinClose(label)}
          className="absolute top-1.5 right-1.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
