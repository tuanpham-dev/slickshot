import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FolderOpen, AlertTriangle, ClipboardCopy, RefreshCw } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { Segmented } from "../ui/Segmented";
import { Select } from "../ui/Select";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import { Field, Input } from "../ui/Field";
import { Button } from "../ui/Button";
import { ShortcutRecorder } from "../ui/ShortcutRecorder";
import { ConfirmDialog } from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import { storeTheme, type ThemeOverride } from "../lib/theme";
import {
  getSettings,
  setSettings,
  resetSettings,
  onHotkeyError,
  ocrListLangs,
  ocrEngineStatus,
  copyTextToClipboard,
  type AppSettings,
  type CaptureMode,
  type OcrEngineStatus,
} from "../lib/ipc";

const MODE_LABELS: Record<CaptureMode, string> = {
  region: "Region",
  screen: "Screen",
  window: "Window",
  monitor: "Monitor",
  translate: "Extract text",
  region_repeat: "Repeat last region",
  color: "Pick color",
  measure: "Measure",
};

const TARGET_LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "vi", label: "Vietnamese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "ru", label: "Russian" },
  { value: "th", label: "Thai" },
  { value: "ar", label: "Arabic" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "hi", label: "Hindi" },
  { value: "id", label: "Indonesian" },
];

function findConflict(hotkeys: AppSettings["hotkeys"], mode: CaptureMode, accelerator: string): string | null {
  if (!accelerator) return null; // cleared shortcuts never conflict
  const clash = hotkeys.find((h) => h.mode !== mode && h.accelerator === accelerator);
  return clash ? `Already used by ${MODE_LABELS[clash.mode]}` : null;
}

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setLocalSettings] = useState<AppSettings | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [hotkeyErrors, setHotkeyErrors] = useState<string[]>([]);
  const [ocrLangs, setOcrLangs] = useState<string[]>([]);
  const [ocrStatus, setOcrStatus] = useState<OcrEngineStatus | null>(null);
  const [checkingOcr, setCheckingOcr] = useState(false);
  const toast = useToast();

  function refreshOcrStatus() {
    return ocrEngineStatus()
      .then(setOcrStatus)
      .catch(() => {});
  }

  useEffect(() => {
    getSettings()
      .then(setLocalSettings)
      .catch((err) => toast.show({ kind: "error", title: "Couldn't load settings", description: String(err) }));
    ocrListLangs()
      .then(setOcrLangs)
      .catch(() => {});
    refreshOcrStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCheckOcrAgain() {
    setCheckingOcr(true);
    try {
      const status = await ocrEngineStatus();
      setOcrStatus(status);
      if (status.available) {
        toast.show({ kind: "success", title: "Tesseract found", description: "OCR is ready to use." });
        ocrListLangs()
          .then(setOcrLangs)
          .catch(() => {});
      } else {
        toast.show({ kind: "error", title: "Still not found", description: "Run the install command, then try again." });
      }
    } finally {
      setCheckingOcr(false);
    }
  }

  async function copyOcrInstallHint() {
    if (!ocrStatus?.install_hint) return;
    try {
      await copyTextToClipboard(ocrStatus.install_hint);
      toast.show({ kind: "success", title: "Copied to clipboard" });
    } catch (err) {
      toast.show({ kind: "error", title: "Copy failed", description: String(err) });
    }
  }

  useEffect(() => {
    const unlisten = onHotkeyError((message) => setHotkeyErrors((prev) => [...prev, message]));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function persist(next: AppSettings) {
    setLocalSettings(next);
    try {
      await setSettings(next);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't save settings", description: String(err) });
    }
  }

  function update(partial: Partial<AppSettings>) {
    if (!settings) return;
    persist({ ...settings, ...partial });
  }

  function updateHotkey(mode: CaptureMode, accelerator: string) {
    if (!settings) return;
    setHotkeyErrors([]);
    const hotkeys = settings.hotkeys.map((h) => (h.mode === mode ? { ...h, accelerator } : h));
    persist({ ...settings, hotkeys });
  }

  function handleThemeChange(theme: ThemeOverride) {
    storeTheme(theme);
    update({ theme });
  }

  async function handleChooseFolder() {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") update({ save_dir: dir });
  }

  async function handleReset() {
    try {
      const defaults = await resetSettings();
      setLocalSettings(defaults);
      storeTheme(defaults.theme);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't reset settings", description: String(err) });
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-[var(--fg-muted)]">Loading…</span>
      </div>
    );
  }

  const ocrLangOptions = Array.from(new Set([settings.ocr_lang, ...ocrLangs])).sort().map((l) => ({
    value: l,
    label: l,
  }));

  return (
    <div className="flex flex-col h-full bg-[var(--bg)]">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <IconButton label="Back" icon={<ArrowLeft size={16} />} onClick={onBack} />
        <h1 className="text-sm font-semibold text-[var(--fg)]">Settings</h1>
      </div>

      <div className="flex-1 px-4 py-2 flex flex-col gap-6 overflow-y-auto">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--fg)]">General</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Open editor after capture</span>
            <Switch
              aria-label="Open editor after capture"
              checked={settings.open_editor_after_capture}
              onChange={(v) => update({ open_editor_after_capture: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Also copy on capture</span>
            <Switch
              aria-label="Also copy on capture"
              checked={settings.copy_on_capture}
              onChange={(v) => update({ copy_on_capture: v })}
            />
          </div>
        </section>

        <section className="flex flex-col gap-3 pt-5 border-t border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--fg)]">Shortcuts</h2>
          {hotkeyErrors.length > 0 && (
            <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger)]/10 px-3 py-2">
              {hotkeyErrors.map((message, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-[var(--danger)]">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{message}</span>
                </div>
              ))}
            </div>
          )}
          {settings.hotkeys.map((h) => (
            <div key={h.mode} className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">{MODE_LABELS[h.mode]}</span>
              <ShortcutRecorder
                value={h.accelerator}
                onChange={(accel) => updateHotkey(h.mode, accel)}
                conflict={findConflict(settings.hotkeys, h.mode, h.accelerator)}
              />
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-3 pt-5 border-t border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--fg)]">Output</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Save folder</span>
            <Button variant="secondary" size="sm" icon={<FolderOpen size={14} />} onClick={handleChooseFolder}>
              {settings.save_dir ? shortenPath(settings.save_dir) : "Pictures/Screenshots"}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Format</span>
            <Select
              size="sm"
              aria-label="Default format"
              value={settings.default_format}
              onChange={(v) => update({ default_format: v as AppSettings["default_format"] })}
              options={[
                { value: "png", label: "PNG" },
                { value: "jpg", label: "JPG" },
              ]}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-[var(--fg)] shrink-0">JPEG quality</span>
            <div className="w-32">
              <Slider
                aria-label="JPEG quality"
                value={settings.jpeg_quality}
                min={10}
                max={100}
                disabled={settings.default_format !== "jpg"}
                onChange={(v) => update({ jpeg_quality: v })}
              />
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3 pt-5 border-t border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--fg)]">Appearance</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Theme</span>
            <Segmented
              size="sm"
              aria-label="Theme"
              value={settings.theme}
              onChange={handleThemeChange}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
        </section>

        <section className="flex flex-col gap-3 pt-5 border-t border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--fg)]">Translation</h2>
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm text-[var(--fg)]">Enable OCR translation</span>
              <span className="text-[11px] text-[var(--fg-muted)]">
                Sends recognized text to Google Translate.
              </span>
            </div>
            <Switch
              aria-label="Enable OCR translation"
              checked={settings.translate_enabled}
              onChange={(v) => update({ translate_enabled: v })}
            />
          </div>
          {settings.translate_enabled && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--fg)]">Translate to</span>
                <Select
                  aria-label="Translate to"
                  value={settings.translate_target}
                  onChange={(v) => update({ translate_target: v })}
                  options={TARGET_LANGUAGES}
                />
              </div>
              {ocrStatus && !ocrStatus.available && ocrStatus.install_hint ? (
                <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--danger)] bg-[var(--danger)]/10 px-3 py-2">
                  <div className="flex items-start gap-2 text-xs text-[var(--danger)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>OCR needs Tesseract, which isn't installed. Install it, then check again.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[11px] text-[var(--fg)] break-all">{ocrStatus.install_hint}</code>
                    <IconButton
                      label="Copy command"
                      size="sm"
                      icon={<ClipboardCopy size={13} />}
                      onClick={copyOcrInstallHint}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<RefreshCw size={13} />}
                    loading={checkingOcr}
                    onClick={handleCheckOcrAgain}
                  >
                    Check again
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--fg)]">OCR language</span>
                    <Select
                      aria-label="OCR language"
                      value={settings.ocr_lang}
                      onChange={(v) => update({ ocr_lang: v })}
                      options={ocrLangOptions}
                    />
                  </div>
                  <p className="text-[11px] text-[var(--fg-muted)]">
                    More languages are offered for download automatically when detected, or can be installed as
                    tesseract-langpack-* system packages.
                  </p>
                </>
              )}
            </>
          )}
        </section>

        <section className="flex flex-col gap-3 pt-5 border-t border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--fg)]">Upload</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Upload to</span>
            <Select
              aria-label="Upload to"
              value={settings.upload_provider}
              onChange={(v) => update({ upload_provider: v as AppSettings["upload_provider"] })}
              options={[
                { value: "catbox", label: "catbox.moe (no account)" },
                { value: "imgur", label: "Imgur" },
                { value: "s3", label: "S3-compatible" },
              ]}
            />
          </div>
          {settings.upload_provider === "imgur" && (
            <Field label="Imgur Client ID" hint="Create a free Client ID at api.imgur.com/oauth2/addclient. Uploads are anonymous — anyone with the link can view them.">
              <Input
                value={settings.imgur_client_id}
                onChange={(e) => update({ imgur_client_id: e.target.value })}
                placeholder="e.g. 0123456789abcde"
              />
            </Field>
          )}
          {settings.upload_provider === "s3" && (
            <>
              <Field
                label="Bucket"
                hint="Works with AWS S3, MinIO, Cloudflare R2 and Backblaze B2. Credentials are stored in plain text in this app's settings file."
              >
                <Input
                  value={settings.s3_bucket}
                  onChange={(e) => update({ s3_bucket: e.target.value })}
                  placeholder="my-screenshots"
                />
              </Field>
              <Field label="Endpoint" hint="Leave blank for AWS S3.">
                <Input
                  value={settings.s3_endpoint}
                  onChange={(e) => update({ s3_endpoint: e.target.value })}
                  placeholder="https://minio.example.com"
                />
              </Field>
              <Field label="Region">
                <Input
                  value={settings.s3_region}
                  onChange={(e) => update({ s3_region: e.target.value })}
                  placeholder="us-east-1"
                />
              </Field>
              <Field label="Access key">
                <Input
                  value={settings.s3_access_key}
                  onChange={(e) => update({ s3_access_key: e.target.value })}
                  placeholder="AKIA…"
                />
              </Field>
              <Field label="Secret key">
                <Input
                  type="password"
                  value={settings.s3_secret_key}
                  onChange={(e) => update({ s3_secret_key: e.target.value })}
                  placeholder="••••••••"
                />
              </Field>
              <Field label="Key prefix" hint="Optional folder inside the bucket.">
                <Input
                  value={settings.s3_key_prefix}
                  onChange={(e) => update({ s3_key_prefix: e.target.value })}
                  placeholder="screenshots"
                />
              </Field>
              <Field label="Public URL base" hint="Optional CDN or custom domain in front of the bucket.">
                <Input
                  value={settings.s3_public_base}
                  onChange={(e) => update({ s3_public_base: e.target.value })}
                  placeholder="https://cdn.example.com"
                />
              </Field>
            </>
          )}
        </section>

        <div className="pt-5 border-t border-[var(--border)]">
          <Button variant="secondary" size="sm" onClick={() => setResetOpen(true)}>
            Reset to defaults
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset settings?"
        description="This restores all settings, including shortcuts, to their defaults."
        confirmLabel="Reset"
        danger
        onConfirm={handleReset}
      />
    </div>
  );
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}
