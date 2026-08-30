import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Popover as RadixPopover } from "radix-ui";
import {
  Camera,
  Monitor as MonitorIcon,
  ImageIcon,
  AppWindow,
  Maximize,
  Settings as SettingsIcon,
  Languages,
  ScanText,
  Repeat,
  Pipette,
  Ruler,
  History as HistoryIcon,
} from "lucide-react";
import {
  startCapture,
  openImageFile,
  listMonitors,
  getSettings,
  setSettings,
  onOpenSettings,
  ocrEngineStatus,
  type AppSettings,
  type CaptureMode,
  type MonitorInfo,
  type OcrEngineStatus,
} from "../lib/ipc";
import { IconButton } from "../ui/IconButton";
import { Segmented } from "../ui/Segmented";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { Settings } from "./Settings";
import { UploadHistory } from "./UploadHistory";
import { OcrMissingDialog } from "../ui/OcrMissingDialog";

type DelayOption = "0" | "3000" | "5000" | "10000" | "30000";

type PostCaptureOption = AppSettings["post_capture"];

const POST_CAPTURE_OPTIONS: { value: PostCaptureOption; label: string }[] = [
  { value: "editor", label: "Editor" },
  { value: "thumbnail", label: "Thumbnail" },
  { value: "none", label: "Nothing" },
];

const DELAY_OPTIONS: { value: DelayOption; label: string }[] = [
  { value: "0", label: "Off" },
  { value: "3000", label: "3s" },
  { value: "5000", label: "5s" },
  { value: "10000", label: "10s" },
  { value: "30000", label: "30s" },
];

interface ModeTileProps {
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  onClick: () => void;
  disabled?: boolean;
  /** Horizontal, single-row layout for the full-width Translate tile --
   * the square vertical layout at full width would tower over the other
   * tiles and push the delay row below the fold. */
  compact?: boolean;
  /** Dims the tile and shows a warning marker without disabling the click
   * handler -- used for the Extract-text/Translate tile when
   * `ocr_engine_status` reports Tesseract missing, so clicking still opens
   * install guidance instead of doing nothing. */
  warning?: boolean;
}

function ModeTile({ icon, label, shortcut, onClick, disabled, compact, warning }: ModeTileProps) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={[
          "w-full flex items-center gap-2.5 rounded-[var(--radius-md)]",
          "border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5",
          "hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)]",
          "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]",
          "focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50 disabled:cursor-not-allowed",
          warning ? "opacity-60" : "",
        ].join(" ")}
      >
        <span className="text-[var(--accent)]">{icon}</span>
        <span className="text-sm font-medium text-[var(--fg)]">{label}</span>
        {warning && <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] shrink-0" aria-hidden />}
        <span className="ml-auto text-[10px] font-mono text-[var(--fg-muted)]">{shortcut}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "w-full flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)]",
        "border border-[var(--border)] bg-[var(--surface)] py-4",
        "hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)]",
        "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]",
        "focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50 disabled:cursor-not-allowed",
      ].join(" ")}
    >
      <span className="text-[var(--accent)]">{icon}</span>
      <span className="text-sm font-medium text-[var(--fg)]">{label}</span>
      <span className="text-[10px] font-mono text-[var(--fg-muted)]">{shortcut}</span>
    </button>
  );
}

function MonitorTile({ disabled, busy, onPick }: { disabled?: boolean; busy: boolean; onPick: (id: number) => void }) {
  const [monitors, setMonitors] = useState<MonitorInfo[] | null>(null);
  const [open, setOpen] = useState(false);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && monitors === null) {
      try {
        setMonitors(await listMonitors());
      } catch {
        setMonitors([]);
      }
    }
  }

  return (
    <RadixPopover.Root open={open} onOpenChange={handleOpenChange}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={[
            "flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)]",
            "border border-[var(--border)] bg-[var(--surface)] py-4",
            "hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)]",
            "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]",
            "focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          <span className="text-[var(--accent)]">
            <MonitorIcon size={22} />
          </span>
          <span className="text-sm font-medium text-[var(--fg)]">Monitor</span>
          <span className="text-[10px] font-mono text-[var(--fg-muted)]">Pick…</span>
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          sideOffset={8}
          className="z-50 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] p-1.5 w-56 flex flex-col gap-0.5"
        >
          {monitors === null && (
            <div className="px-2.5 py-2 text-xs text-[var(--fg-muted)]">Loading monitors…</div>
          )}
          {monitors?.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-[var(--fg-muted)]">No monitors found</div>
          )}
          {monitors?.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onPick(m.id);
              }}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-sm)] text-sm text-[var(--fg)] hover:bg-[var(--surface-hover)] text-left"
            >
              <span>{m.name || `Monitor ${m.id}`}</span>
              <span className="text-[10px] text-[var(--fg-muted)] font-mono">
                {m.rect.w}×{m.rect.h}
              </span>
            </button>
          ))}
          <RadixPopover.Arrow className="fill-[var(--surface)]" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export function MainWindow() {
  const [delay, setDelayState] = useState<DelayOption>("0");
  const [postCapture, setPostCaptureState] = useState<PostCaptureOption>("editor");
  const [settings, setLocalSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<OcrEngineStatus | null>(null);
  const [ocrMissingOpen, setOcrMissingOpen] = useState(false);
  const toast = useToast();

  // The window is a fixed, non-resizable size, so on unusually tall content
  // (large OS font scaling, a long save-folder path wrapping, etc.) the tile
  // list can still need to scroll to reach "Open image…"/Delay below it --
  // this fade hints that there's more below instead of the list just
  // stopping with no affordance. Recomputed on scroll and on content/window
  // size changes (ResizeObserver), not just once at mount.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollHint, setShowScrollHint] = useState(false);

  function updateScrollHint() {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollHint(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollHint();
    const observer = new ResizeObserver(updateScrollHint);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function refreshSettings() {
    return getSettings()
      .then((s) => {
        setLocalSettings(s);
        setDelayState(String(s.default_delay_ms) as DelayOption);
        setPostCaptureState(s.post_capture);
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshSettings();
  }, []);

  // Re-checked on every mount, not cached: installing Tesseract mid-session
  // (the Settings/dialog "Check again" also does this) should unlock OCR
  // without an app restart, and this window can be shown again after being
  // hidden for a while.
  useEffect(() => {
    ocrEngineStatus()
      .then(setOcrStatus)
      .catch(() => {});
  }, []);

  function handleTranslateClick() {
    if (ocrStatus && !ocrStatus.available) {
      setOcrMissingOpen(true);
      return;
    }
    trigger("translate");
  }

  useEffect(() => {
    const unlisten = onOpenSettings(() => setSettingsOpen(true));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function handleDelayChange(next: DelayOption) {
    setDelayState(next);
    if (settings) {
      const updated = { ...settings, default_delay_ms: Number(next) };
      setLocalSettings(updated);
      setSettings(updated).catch(() => {});
    }
  }

  function handlePostCaptureChange(next: PostCaptureOption) {
    setPostCaptureState(next);
    if (settings) {
      const updated = { ...settings, post_capture: next };
      setLocalSettings(updated);
      setSettings(updated).catch(() => {});
    }
  }

  function shortcutFor(mode: CaptureMode): string {
    return settings?.hotkeys.find((h) => h.mode === mode)?.accelerator ?? "";
  }

  async function trigger(mode: CaptureMode, targetId?: number) {
    if (busy) return;
    setBusy(true);
    try {
      await startCapture(mode, Number(delay), targetId);
    } catch (err) {
      toast.show({ kind: "error", title: "Capture failed", description: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenImage() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (typeof path === "string") {
      try {
        await openImageFile(path);
      } catch (err) {
        toast.show({ kind: "error", title: "Couldn't open image", description: String(err) });
      }
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (!busy) handleOpenImage();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  if (settingsOpen) {
    // Settings.tsx owns its own copy of `settings` while open and persists
    // changes via `setSettings` -- this window's `settings` state was
    // fetched once at mount and never learns about those changes on its
    // own, so re-fetch on the way back (translate_enabled, hotkeys, etc.
    // would otherwise stay stale until the app restarts).
    return (
      <Settings
        onBack={() => {
          setSettingsOpen(false);
          refreshSettings();
        }}
      />
    );
  }

  if (historyOpen) {
    return <UploadHistory onBack={() => setHistoryOpen(false)} />;
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg)]">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h1 className="text-sm font-semibold text-[var(--fg)]">SlickShot</h1>
        <div className="flex items-center gap-1">
          <IconButton
            label="Upload history"
            icon={<HistoryIcon size={16} />}
            onClick={() => setHistoryOpen(true)}
          />
          <IconButton
            label="Settings"
            icon={<SettingsIcon size={16} />}
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={updateScrollHint}
          className="h-full overflow-y-auto px-4 flex flex-col gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <ModeTile
              icon={<Camera size={22} />}
              label="Region"
              shortcut={shortcutFor("region")}
              onClick={() => trigger("region")}
              disabled={busy}
            />
            <ModeTile
              icon={<Maximize size={22} />}
              label="Screen"
              shortcut={shortcutFor("screen")}
              onClick={() => trigger("screen")}
              disabled={busy}
            />
            <ModeTile
              icon={<AppWindow size={22} />}
              label="Window"
              shortcut={shortcutFor("window")}
              onClick={() => trigger("window")}
              disabled={busy}
            />
            <MonitorTile busy={busy} onPick={(id) => trigger("monitor", id)} />
            <div className="col-span-2">
              <ModeTile
                compact
                icon={settings?.translate_enabled ? <Languages size={18} /> : <ScanText size={18} />}
                label={settings?.translate_enabled ? "Translate/Extract text" : "Extract text"}
                shortcut={shortcutFor("translate")}
                onClick={handleTranslateClick}
                disabled={busy}
                warning={ocrStatus !== null && !ocrStatus.available}
              />
            </div>
            <ModeTile
              compact
              icon={<Repeat size={18} />}
              label="Repeat region"
              shortcut={shortcutFor("region_repeat")}
              onClick={() => trigger("region_repeat")}
              disabled={busy}
            />
            <ModeTile
              compact
              icon={<Pipette size={18} />}
              label="Pick color"
              shortcut={shortcutFor("color")}
              onClick={() => trigger("color")}
              disabled={busy}
            />
            <div className="col-span-2">
              <ModeTile
                compact
                icon={<Ruler size={18} />}
                label="Measure"
                shortcut={shortcutFor("measure")}
                onClick={() => trigger("measure")}
                disabled={busy}
              />
            </div>
          </div>

          <ModeTile
            compact
            icon={<ImageIcon size={18} />}
            label="Open image…"
            shortcut="Ctrl+O"
            onClick={handleOpenImage}
            disabled={busy}
          />

          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Delay</span>
            <Segmented aria-label="Capture delay" value={delay} onChange={handleDelayChange} options={DELAY_OPTIONS} />
          </div>

          {/* Alongside Delay rather than buried in Settings: both decide what
              the very next capture does, so they belong where the capture is
              started. */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--fg-muted)]">After capture</span>
            <Segmented
              aria-label="After capture"
              value={postCapture}
              onChange={handlePostCaptureChange}
              options={POST_CAPTURE_OPTIONS}
            />
          </div>
        </div>
        {showScrollHint && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--bg)] to-transparent"
          />
        )}
      </div>

      <div className="px-4 pb-4 pt-2">
        <div className="flex items-center justify-between text-[11px] text-[var(--fg-muted)] border-t border-[var(--border)] pt-3">
          <span>Saves to {settings?.save_dir ?? "~/Pictures/Screenshots"}</span>
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            Change
          </Button>
        </div>
      </div>

      {ocrStatus && !ocrStatus.available && ocrStatus.install_hint && (
        <OcrMissingDialog
          open={ocrMissingOpen}
          onOpenChange={setOcrMissingOpen}
          installHint={ocrStatus.install_hint}
          onAvailable={() => setOcrStatus({ available: true, install_hint: null })}
        />
      )}
    </div>
  );
}
