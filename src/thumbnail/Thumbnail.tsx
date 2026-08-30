import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy, Download, Pencil, Pin, Trash2, Upload } from "lucide-react";
import {
  fetchShotImage,
  frontendMounted,
  thumbnailAction,
  thumbnailClose,
  thumbnailReady,
  type ThumbnailAction,
} from "../lib/ipc";
import { IconButton } from "../ui/IconButton";

interface ThumbnailProps {
  params: URLSearchParams;
}

/** How long the thumbnail lingers before dismissing itself. Long enough to
 * notice and reach, short enough not to camp on the screen. */
const DISMISS_MS = 6000;
const TICK_MS = 50;

const ACTIONS: { id: ThumbnailAction; label: string; icon: React.ReactNode }[] = [
  { id: "copy", label: "Copy", icon: <Copy size={16} /> },
  { id: "quicksave", label: "Save", icon: <Download size={16} /> },
  { id: "pin", label: "Pin to screen", icon: <Pin size={16} /> },
  { id: "edit", label: "Edit", icon: <Pencil size={16} /> },
  { id: "upload", label: "Upload", icon: <Upload size={16} /> },
];

export function Thumbnail({ params }: ThumbnailProps) {
  // The window is reused across captures (see `thumbnail::show`): the first
  // capture arrives as a URL param, every later one as an event.
  const [imageId, setImageId] = useState<string | null>(params.get("image"));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [remaining, setRemaining] = useState(DISMISS_MS);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    frontendMounted();
    const unlisten = listen<string>("thumbnail:image", (e) => {
      setImageId(e.payload);
      setRemaining(DISMISS_MS);
      setBusy(false);
      setError(null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!imageId) return;
    let stale = false;
    fetchShotImage(imageId)
      .then((bitmap) => {
        if (stale) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        thumbnailReady();
      })
      .catch((err) => {
        // Nothing to preview means nothing to act on, so tear the window
        // down rather than leave an empty always-on-top box behind.
        console.error("thumbnail image load failed", err);
        // Nothing was decoded, so there is nothing worth saving.
        if (!stale) thumbnailClose(true);
      });
    return () => {
      stale = true;
    };
  }, [imageId]);

  // Countdown pauses while the pointer is over the window (the user is
  // reaching for a button) and while an action is in flight.
  useEffect(() => {
    if (paused || busy) return;
    const timer = setInterval(() => {
      setRemaining((r) => {
        const next = r - TICK_MS;
        if (next <= 0) {
          clearInterval(timer);
          // Timing out means the user never chose -- auto-save (when on)
          // keeps the capture rather than silently dropping it.
          thumbnailClose(false);
          return 0;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [paused, busy]);

  const runAction = useCallback(async (action: ThumbnailAction) => {
    setBusy(true);
    setError(null);
    try {
      await thumbnailAction(action);
    } catch (err) {
      // Upload is the realistic failure here; keep the window open with the
      // reason rather than dismissing as if it had worked.
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") thumbnailClose(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      className="w-screen h-screen flex flex-col bg-[var(--surface)] border border-[var(--border)] rounded-lg overflow-hidden select-none"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <div className="flex-1 min-h-0 p-2">
        <canvas
          ref={canvasRef}
          className="w-full h-full object-contain"
          style={{ objectFit: "contain" }}
        />
      </div>

      {error && (
        <div className="px-3 pb-1 text-[11px] text-[var(--danger)] truncate" title={error}>
          {error}
        </div>
      )}

      <div className="flex items-center justify-around px-2 py-1.5 border-t border-[var(--border)]">
        {ACTIONS.map((a) => (
          <IconButton
            key={a.id}
            label={a.label}
            icon={a.icon}
            disabled={busy}
            onClick={() => runAction(a.id)}
          />
        ))}
        {/* The one way to throw a capture away on purpose. Everything else
            here -- including letting the timer run out -- keeps it. */}
        <IconButton
          label="Discard"
          icon={<Trash2 size={16} />}
          disabled={busy}
          onClick={() => thumbnailClose(true)}
        />
      </div>

      {/* Dismissal countdown: a hairline rather than a number, so it reads as
          ambient rather than as a deadline. */}
      <div className="h-0.5 bg-[var(--border)]">
        <div
          className="h-full bg-[var(--accent)]"
          style={{
            width: `${(remaining / DISMISS_MS) * 100}%`,
            transition: paused || busy ? "none" : `width ${TICK_MS}ms linear`,
            opacity: paused || busy ? 0.35 : 1,
          }}
        />
      </div>
    </div>
  );
}
