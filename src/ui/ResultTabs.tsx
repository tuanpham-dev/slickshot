import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Loader2, Download, Volume2, Square } from "lucide-react";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { copyTextToClipboard, narrateText } from "../lib/ipc";

interface MissingLang {
  isoCode: string;
  label: string;
}

export type ResultTab = "origin" | "translation";

type NarrateSource = "origin" | "translation";

interface ResultTabsProps {
  tab: ResultTab;
  onTabChange: (tab: ResultTab) => void;
  origin: string;
  enabled: boolean;
  translated: string | null;
  translating: boolean;
  translateError: string | null;
  truncated: boolean;
  missingLang: MissingLang | null;
  downloadingLang: boolean;
  onDownloadLang: (isoCode: string) => void;
  /** Language code for narrating the original text -- the detected source
   * language when known (from a completed translation), else a sensible
   * fallback the caller picks (e.g. the app's translate_target). */
  originLang: string;
  /** Target language code for narrating the translation -- Google
   * Translate's own TTS voice, same as the app's `translate_target`
   * setting. */
  translateLang: string;
}

/** Original/Translation tab pair shared by the editor's OCR popover and the
 * overlay's translation-mode popover. Renders as a single pane (no tabs)
 * when translation is disabled, matching the original OCR-only popover.
 * `tab` is controlled by the caller so each surface can pick its own default
 * (translation mode opens straight to "translation") and persist the user's
 * last choice across repeated extractions instead of resetting every time. */
export function ResultTabs({
  tab,
  onTabChange,
  origin,
  enabled,
  translated,
  translating,
  translateError,
  truncated,
  missingLang,
  downloadingLang,
  onDownloadLang,
  originLang,
  translateLang,
}: ResultTabsProps) {
  const toast = useToast();
  // Only one narration plays at a time; `source` says which button (origin's
  // or translation's) owns the current loading/playing state so the other
  // stays showing its idle "Listen" icon.
  const [narrate, setNarrate] = useState<{ source: NarrateSource; status: "loading" | "playing" } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop playback and free the object URL whenever the popover this lives in
  // unmounts (region dismissed, a new extraction replaces it) -- otherwise a
  // previous narration keeps playing after its text is gone from the screen.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  async function copy(text: string) {
    try {
      await copyTextToClipboard(text);
      toast.show({ kind: "success", title: "Copied to clipboard" });
    } catch (err) {
      toast.show({ kind: "error", title: "Copy failed", description: String(err) });
    }
  }

  function stopNarration() {
    audioRef.current?.pause();
    audioRef.current = null;
    setNarrate(null);
  }

  async function toggleNarrate(source: NarrateSource, text: string, lang: string) {
    if (narrate) {
      stopNarration();
      if (narrate.source === source) return; // was this button's own audio -- just stop
    }
    setNarrate({ source, status: "loading" });
    try {
      const bytes = await narrateText(text, lang);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setNarrate((s) => (audioRef.current === audio ? null : s));
      };
      setNarrate({ source, status: "playing" });
      await audio.play();
    } catch (err) {
      setNarrate(null);
      toast.show({ kind: "error", title: "Couldn't play narration", description: String(err) });
    }
  }

  function ListenButton({ source, text, lang }: { source: NarrateSource; text: string; lang: string }) {
    const status = narrate?.source === source ? narrate.status : "idle";
    return (
      <Button
        variant="secondary"
        size="sm"
        icon={
          status === "loading" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : status === "playing" ? (
            <Square size={14} />
          ) : (
            <Volume2 size={14} />
          )
        }
        onClick={() => toggleNarrate(source, text, lang)}
      >
        {status === "playing" ? "Stop" : "Listen"}
      </Button>
    );
  }

  if (!enabled) {
    // Narration shares translate_enabled's opt-in gate (it also sends text
    // to a Google endpoint), so no Listen button here -- it would only ever
    // error. It's offered on the Original/Translation tabs below instead,
    // which don't render at all unless translation is enabled.
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--fg)] max-h-40 overflow-y-auto whitespace-pre-wrap select-text">{origin}</p>
        <Button variant="primary" size="sm" icon={<ClipboardCopy size={14} />} onClick={() => copy(origin)}>
          Copy text
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] p-0.5">
        {(["origin", "translation"] as ResultTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTabChange(t)}
            className={[
              "flex-1 h-7 rounded-[var(--radius-sm)] text-xs font-medium transition-colors",
              tab === t
                ? "bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-sm)]"
                : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
            ].join(" ")}
          >
            {t === "origin" ? "Original" : "Translation"}
          </button>
        ))}
      </div>

      {tab === "origin" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--fg)] max-h-40 overflow-y-auto whitespace-pre-wrap select-text">{origin}</p>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" icon={<ClipboardCopy size={14} />} onClick={() => copy(origin)}>
              Copy text
            </Button>
            <ListenButton source="origin" text={origin} lang={originLang} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {translating ? (
            <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
              <Loader2 size={14} className="animate-spin" /> Translating…
            </div>
          ) : translateError ? (
            <p className="text-sm text-[var(--danger)]">{translateError}</p>
          ) : (
            <>
              <p className="text-sm text-[var(--fg)] max-h-40 overflow-y-auto whitespace-pre-wrap select-text">
                {translated}
              </p>
              {truncated && (
                <p className="text-xs text-[var(--fg-muted)]">(input was truncated for translation)</p>
              )}
              {missingLang && (
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2">
                  <span className="text-xs text-[var(--fg-muted)]">
                    Detected {missingLang.label} — OCR data not installed
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={downloadingLang ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    disabled={downloadingLang}
                    onClick={() => onDownloadLang(missingLang.isoCode)}
                  >
                    Download
                  </Button>
                </div>
              )}
              {translated !== null && (
                <div className="flex gap-2">
                  <Button variant="primary" size="sm" icon={<ClipboardCopy size={14} />} onClick={() => copy(translated)}>
                    Copy text
                  </Button>
                  <ListenButton source="translation" text={translated} lang={translateLang} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
