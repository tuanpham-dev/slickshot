import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Kbd } from "./Kbd";
import { Button } from "./Button";
import { IconButton } from "./IconButton";

function codeToKeyName(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  const direct: Record<string, string> = {
    PrintScreen: "PrintScreen",
    Escape: "Escape",
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
  };
  if (direct[code]) return direct[code];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

function isModifierCode(code: string): boolean {
  return [
    "ControlLeft",
    "ControlRight",
    "ShiftLeft",
    "ShiftRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
  ].includes(code);
}

export function acceleratorParts(accelerator: string): string[] {
  return accelerator.split("+");
}

interface ShortcutRecorderProps {
  value: string;
  onChange: (accelerator: string) => void;
  conflict?: string | null;
}

export function ShortcutRecorder({ value, onChange, conflict }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(false);
        return;
      }
      if (isModifierCode(e.code)) return;

      const key = codeToKeyName(e.code);
      if (!key) return;

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");
      parts.push(key);
      onChange(parts.join("+"));
      setRecording(false);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, onChange]);

  if (recording) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setRecording(false)}>
        Press keys… (Esc to cancel)
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1 items-end">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setRecording(true)}
          className="flex items-center gap-1 hover:bg-[var(--surface-hover)] rounded-[var(--radius-sm)] px-1.5 py-1"
        >
          {value ? (
            acceleratorParts(value).map((part, i) => <Kbd key={i}>{part}</Kbd>)
          ) : (
            <span className="text-xs text-[var(--fg-subtle)]">Click to set shortcut</span>
          )}
        </button>
        {value && (
          <IconButton
            label="Clear shortcut"
            icon={<X size={12} />}
            size="sm"
            onClick={() => onChange("")}
          />
        )}
      </div>
      {conflict && <span className="text-xs text-[var(--danger)]">{conflict}</span>}
    </div>
  );
}
