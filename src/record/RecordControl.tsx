import { useEffect, useState } from "react";
import { Mic, Square, Volume2, X } from "lucide-react";
import { useWindowDrag } from "../lib/useWindowDrag";
import { Button } from "../ui/Button";
import { onRecordProgress, onRecordWarning, recordCancel, recordStop } from "../lib/ipc";

function timecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

interface RecordControlProps {
  params: URLSearchParams;
}

/** The only thing on screen while a recording runs -- the same shape as the
 * scrolling-capture pill, since it does the same job: say what is happening
 * and offer the two ways out. Draggable for the same reason too: a region
 * filling the monitor leaves nowhere to put this that isn't over the content. */
export function RecordControl({ params }: RecordControlProps) {
  const drag = useWindowDrag();
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // The audio badges come from the URL rather than a round trip: the pill is
  // built by the same call that started the recording, so the flags are
  // already known and a fetch would just make them appear late.
  const systemAudio = params.get("system") === "1";
  const microphone = params.get("mic") === "1";

  useEffect(() => {
    const progress = onRecordProgress((p) => setElapsed(p.elapsed_ms));
    const warn = onRecordWarning((message) => setWarning(message));
    return () => {
      progress.then((fn) => fn());
      warn.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setEnding(true);
        recordCancel();
      } else if (e.key === "Enter") {
        setEnding(true);
        recordStop();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      {...drag}
      className="flex items-center justify-between gap-2 h-full w-full px-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] select-none cursor-move"
    >
      {/* `pointer-events-none` on the text, not just the drag attribute on
          its parents: Tauri's drag handler tests the event's own target for
          `data-tauri-drag-region`, and does not walk up to an ancestor. A
          press that landed on the label or the clock therefore hit a <span>
          with no attribute, and the pill would not move. */}
      <div data-tauri-drag-region className="flex flex-col min-w-0 pointer-events-none">
        <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--fg)]">
          {!ending && (
            <span
              aria-hidden
              className="inline-block w-2 h-2 rounded-full bg-[var(--danger,#e5484d)] animate-pulse"
            />
          )}
          {ending ? "Finishing…" : "Recording"}
          {systemAudio && <Volume2 size={11} className="text-[var(--fg-muted)]" aria-label="System audio" />}
          {microphone && <Mic size={11} className="text-[var(--fg-muted)]" aria-label="Microphone" />}
        </span>
        <span className="text-[10px] text-[var(--fg-muted)] tabular-nums whitespace-nowrap">
          {warning ?? timecode(elapsed)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          icon={<X size={14} />}
          iconOnly
          aria-label="Cancel"
          title="Discard (Esc)"
          disabled={ending}
          onClick={() => {
            setEnding(true);
            recordCancel();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          icon={<Square size={13} />}
          aria-label="Stop"
          title="Stop (Enter)"
          disabled={ending}
          onClick={() => {
            setEnding(true);
            recordStop();
          }}
        >
          Stop
        </Button>
      </div>
    </div>
  );
}
