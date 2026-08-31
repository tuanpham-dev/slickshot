import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "../ui/Button";
import { onScrollProgress, scrollCancel, scrollStop } from "../lib/ipc";

/** The only thing on screen while a scrolling capture runs, so it says what
 * is happening and offers the two ways out. The whole pill is a drag region:
 * a region filling the monitor leaves nowhere to put this that isn't over the
 * content, so it has to be movable. */
export function ScrollControl() {
  const [height, setHeight] = useState(0);
  const [frames, setFrames] = useState(0);
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    const unlisten = onScrollProgress((p) => {
      setHeight(p.height);
      setFrames(p.frames);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setEnding(true);
        scrollCancel();
      } else if (e.key === "Enter") {
        setEnding(true);
        scrollStop();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between gap-2 h-full w-full px-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] select-none cursor-move"
    >
      <div data-tauri-drag-region className="flex flex-col min-w-0">
        <span className="text-xs font-medium text-[var(--fg)]">
          {ending ? "Finishing…" : "Scrolling…"}
        </span>
        <span className="text-[10px] text-[var(--fg-muted)] tabular-nums whitespace-nowrap">
          {height.toLocaleString()}px · {frames} frame{frames === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          icon={<X size={14} />}
          iconOnly
          aria-label="Cancel"
          title="Cancel (Esc)"
          disabled={ending}
          onClick={() => {
            setEnding(true);
            scrollCancel();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<Check size={14} />}
          aria-label="Done"
          title="Done (Enter)"
          disabled={ending}
          onClick={() => {
            setEnding(true);
            scrollStop();
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
