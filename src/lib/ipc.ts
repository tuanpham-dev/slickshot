import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PhysPoint, PhysRect } from "./geometry";

export type CaptureMode =
  | "screen"
  | "monitor"
  | "region"
  | "region_repeat"
  | "window"
  | "translate"
  | "color"
  | "measure"
  | "region_quicksave";

export interface MonitorInfo {
  id: number;
  name: string;
  rect: PhysRect;
  is_primary: boolean;
}

export interface WindowInfo {
  id: number;
  title: string;
  app_name: string;
  rect: PhysRect;
}

export interface CommandErrorPayload {
  message?: string;
  [key: string]: unknown;
}

export class IpcError extends Error {
  constructor(cause: unknown) {
    super(typeof cause === "string" ? cause : JSON.stringify(cause));
    this.name = "IpcError";
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw new IpcError(err);
  }
}

export const listMonitors = () => call<MonitorInfo[]>("list_monitors");
export const listWindows = () => call<WindowInfo[]>("list_windows");

export const startCapture = (mode: CaptureMode, delayMs: number, targetId?: number) =>
  call<void>("start_capture", { mode, delayMs, targetId: targetId ?? null });

export const openImageFile = (path: string) => call<void>("open_image_file", { path });
/** Loads an image file into the store for insertion into the current
 * annotation session (does not open the editor). Release it when done. */
export const loadImageFile = (path: string) => call<string>("load_image_file", { path });
export const releaseImage = (imageId: string) => call<void>("release_image", { imageId });
/** Image id for a picture on the system clipboard, or null if there isn't
 * one. Read natively because WebKitGTK never delivers a `paste` event to the
 * page unless an editable element has focus. */
export const readClipboardImage = () => call<string | null>("read_clipboard_image");
export const openEditor = (imageId: string) => call<void>("open_editor", { imageId });
export const showMainWindow = () => call<void>("show_main_window");
export const cursorPhysicalPosition = () =>
  call<{ x: number; y: number }>("cursor_physical_position");

// These resolve with the resulting rect (in addition to the `selection:changed`
// broadcast every one of them also emits), so a caller needing the value right
// away -- translation mode's pointer-up handler -- isn't a frame behind the
// broadcast listener.
export const selectionBegin = (point: PhysPoint) => call<PhysRect | null>("selection_begin", { point });
export const selectionUpdate = (point: PhysPoint) => call<PhysRect | null>("selection_update", { point });
export const selectionEnd = (point: PhysPoint) => call<PhysRect | null>("selection_end", { point });
export const selectionSetRect = (rect: PhysRect) => call<PhysRect | null>("selection_set_rect", { rect });
export const selectionCancel = () => call<void>("selection_cancel");
export const selectionConfirm = () => call<void>("selection_confirm");
export const selectionConfirmWindow = (rect: PhysRect) =>
  call<void>("selection_confirm_window", { rect });
export const selectionConfirmPin = () => call<void>("selection_confirm_pin");

export interface SelectionChangedEvent {
  rect: PhysRect | null;
}

export function onSelectionChanged(
  cb: (event: SelectionChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SelectionChangedEvent>("selection:changed", (e) => cb(e.payload));
}

export function onHotkeyError(cb: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>("hotkeys:error", (e) => cb(e.payload));
}

export function onOpenSettings(cb: () => void): Promise<UnlistenFn> {
  return listen<void>("open_settings", () => cb());
}

export type ExportAction =
  | { kind: "clipboard" }
  | { kind: "save"; path: string }
  | { kind: "quicksave" };

export interface ExportResult {
  saved_path: string | null;
}

export const exportPrepare = (action: ExportAction) => call<void>("export_prepare", { action });

export async function exportCommit(pngBytes: Uint8Array): Promise<ExportResult> {
  try {
    return await invoke<ExportResult>("export_commit", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

export interface HotkeyBinding {
  accelerator: string;
  mode: CaptureMode;
}

export interface AppSettings {
  save_dir: string | null;
  default_format: "png" | "jpg" | "webp" | "avif";
  jpeg_quality: number;
  avif_quality: number;
  hotkeys: HotkeyBinding[];
  default_delay_ms: number;
  /** Superseded by `post_capture`; still sent so an old settings.json keeps
   * round-tripping through set_settings unchanged. */
  open_editor_after_capture: boolean;
  copy_on_capture: boolean;
  post_capture: "editor" | "thumbnail" | "none";
  auto_save: boolean;
  theme: "system" | "light" | "dark";
  translate_enabled: boolean;
  translate_target: string;
  ocr_lang: string;
  upload_provider: "catbox" | "imgur" | "s3" | "imgbb" | "gdrive";
  imgur_client_id: string;
  imgbb_api_key: string;
  gdrive_client_id: string;
  export_scale: number;
  s3_endpoint: string;
  s3_region: string;
  s3_bucket: string;
  s3_access_key: string;
  s3_secret_key: string;
  s3_key_prefix: string;
  s3_public_base: string;
  auto_check_updates: boolean;
}

export const getSettings = () => call<AppSettings>("get_settings");
export const setSettings = (settings: AppSettings) => call<void>("set_settings", { settings });
export const resetSettings = () => call<AppSettings>("reset_settings");

export async function ocrExtract(pngBytes: Uint8Array): Promise<string> {
  try {
    return await invoke<string>("ocr_extract", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

/** Word-level bounding boxes for the same PNG `ocrExtract` reads, in image
 * pixels -- backs auto-redaction and the highlighter's text-line snapping. */
export async function ocrBoxes(pngBytes: Uint8Array): Promise<OcrWordBox[]> {
  try {
    return await invoke<OcrWordBox[]>("ocr_boxes", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Frontal-face boxes in the given PNG, in image pixels. Runs on-device via
 * the bundled SeetaFace model -- no network, no per-use download. */
export async function detectFaces(pngBytes: Uint8Array): Promise<FaceBox[]> {
  try {
    return await invoke<FaceBox[]>("detect_faces", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

/** Runs the Google Drive consent flow; resolves with the connected account
 * label once the browser round trip completes. */
export const gdriveSignIn = () => call<string>("gdrive_sign_in");
export const gdriveSignOut = () => call<void>("gdrive_sign_out");
export const gdriveAccount = () => call<string | null>("gdrive_account");

export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
}

export interface UpdateStatus {
  /** False on builds the package manager owns (deb/rpm/AUR). */
  supported: boolean;
  current_version: string;
  available: AvailableUpdate | null;
}

export const checkUpdate = () => call<UpdateStatus>("check_update");
/** Downloads, installs and relaunches -- does not resolve on success. */
export const installUpdate = () => call<void>("install_update");

export function onUpdateAvailable(cb: (update: AvailableUpdate) => void): Promise<UnlistenFn> {
  return listen<AvailableUpdate>("update:available", (e) => cb(e.payload));
}

export const copyTextToClipboard = (text: string) => call<void>("copy_text_to_clipboard", { text });

/** Decodes any QR codes in the same PNG region `ocrExtract` reads text from.
 * Returns an empty array when the region holds none. */
export async function qrDecode(pngBytes: Uint8Array): Promise<string[]> {
  try {
    return await invoke<string[]>("qr_decode", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

export interface Translation {
  translated: string;
  detected_lang: string;
  truncated: boolean;
}

/** `tryPrimary` should come from a `translateServiceAvailable()` check made
 * once when the translate/extract-text tool was activated, not a fresh
 * check per call -- see `translateServiceAvailable` below. */
export async function translateText(text: string, tryPrimary: boolean): Promise<Translation> {
  return call<Translation>("translate_text", { text, tryPrimary });
}

/** Cheap reachability probe for the primary translation endpoint
 * (`translate_a/single`), which can get rate-limited independently of the
 * `translate.google.com/m` fallback `translateText`/`ocrTranslateRegion`
 * fall back to. Meant to be called once when the user activates the
 * translate/extract-text tool (overlay hotkey, or the editor's OCR tool),
 * with the result cached for that tool session and passed as `tryPrimary` to
 * every actual translation performed during it -- not re-checked per
 * drag-selected region. */
export const translateServiceAvailable = () => call<boolean>("translate_service_available");

/** Fetches spoken audio (MP3 bytes) for `text` from Google Translate's own
 * TTS voice for `lang` -- the same "Listen" speaker-icon feature
 * translate.google.com has. */
export async function narrateText(text: string, lang: string): Promise<Uint8Array> {
  const bytes = await call<number[]>("narrate_text", { text, lang });
  return new Uint8Array(bytes);
}

export interface UploadResult {
  url: string;
  delete_url: string | null;
  provider: string;
}

export interface UploadEntry {
  url: string;
  delete_url: string | null;
  provider: string;
  uploaded_at: string;
}

export async function uploadImage(pngBytes: Uint8Array): Promise<UploadResult> {
  try {
    return await invoke<UploadResult>("upload_image", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

export const uploadHistory = () => call<UploadEntry[]>("upload_history");
export const uploadHistoryClear = () => call<void>("upload_history_clear");
export const uploadDelete = (url: string) => call<UploadEntry[]>("upload_delete", { url });

export interface OcrEngineStatus {
  available: boolean;
  install_hint: string | null;
}

export const ocrEngineStatus = () => call<OcrEngineStatus>("ocr_engine_status");

export const ocrListLangs = () => call<string[]>("ocr_list_langs");

export const ocrDownloadLang = (isoCode: string) => call<string>("ocr_download_lang", { isoCode });

export interface OcrTranslateResult {
  origin: string;
  translated: string | null;
  detected_lang: string | null;
  truncated: boolean;
}

/** `tryPrimary` -- see `translateText` above. */
export const ocrTranslateRegion = (rect: PhysRect, tryPrimary: boolean) =>
  call<OcrTranslateResult>("ocr_translate_region", { rect, tryPrimary });

/** Google's translate endpoints report "und" for an undetermined source
 * language (also what translate.rs's mobile-page fallback reports when its
 * own local language detection can't confidently identify one) -- treat it
 * the same as `null` so callers' fallback languages (e.g. for narrating the
 * original text) kick in instead of being handed an unusable "und" language
 * code. */
export function normalizeDetectedLang(lang: string | null): string | null {
  return lang === "und" ? null : lang;
}

/** ISO-639-1 code -> (tesseract language code, human label), for mapping a
 * gtx-detected source language to an installed/downloadable OCR language.
 * Keep in sync with `LANG_MAP` in `src-tauri/src/ocr.rs`. */
export const ISO_TO_OCR_LANG: Record<string, { code: string; label: string }> = {
  en: { code: "eng", label: "English" },
  vi: { code: "vie", label: "Vietnamese" },
  ja: { code: "jpn", label: "Japanese" },
  ko: { code: "kor", label: "Korean" },
  zh: { code: "chi_sim", label: "Chinese (Simplified)" },
  "zh-cn": { code: "chi_sim", label: "Chinese (Simplified)" },
  "zh-tw": { code: "chi_tra", label: "Chinese (Traditional)" },
  de: { code: "deu", label: "German" },
  fr: { code: "fra", label: "French" },
  es: { code: "spa", label: "Spanish" },
  ru: { code: "rus", label: "Russian" },
  th: { code: "tha", label: "Thai" },
  ar: { code: "ara", label: "Arabic" },
  pt: { code: "por", label: "Portuguese" },
  it: { code: "ita", label: "Italian" },
};

export function shotUrl(imageId: string): string {
  return convertFileSrc(imageId, "slickshot");
}

/** Fetches a stored frame from the `slickshot://` protocol as raw RGBA bytes and
 * turns it into a drawable ImageBitmap. Raw instead of PNG because the
 * pixels are already decoded in the Rust process -- round-tripping a full
 * monitor through PNG encode + decode cost seconds per capture in dev
 * builds. Dimensions ride along in response headers. */
export async function fetchShotImage(imageId: string): Promise<ImageBitmap> {
  const resp = await fetch(shotUrl(imageId));
  if (!resp.ok) throw new Error(`slickshot://${imageId} returned ${resp.status}`);
  const width = Number(resp.headers.get("X-Image-Width"));
  const height = Number(resp.headers.get("X-Image-Height"));
  if (!width || !height) throw new Error(`slickshot://${imageId} missing dimension headers`);
  const buf = await resp.arrayBuffer();
  const data = new ImageData(new Uint8ClampedArray(buf), width, height);
  return createImageBitmap(data);
}

/** Hides the (pre-warmed, reused) editor window and frees its image. */
export const editorHide = () => call<void>("editor_hide");

/** Tells Rust this overlay webview has drawn its frozen frame, so the
 * window can be shown without flashing blank content. */
export const overlayReady = (monitorId: number) => call<void>("overlay_ready", { monitorId });

/** Tells Rust the editor webview has rendered the new capture, so the
 * window can be shown without flashing blank/stale content. */
export const editorReady = () => call<void>("editor_ready");

export function onEditorImage(cb: (imageId: string) => void): Promise<UnlistenFn> {
  return listen<string>("editor:image", (e) => cb(e.payload), { target: "editor" });
}

/** Tells Rust this window's event listeners are registered and it's ready
 * to receive a frame -- see `ready::wait_for_mount` on the Rust side for
 * why this matters on a cold start. */
export const frontendMounted = () => call<void>("frontend_mounted");

export const pinReady = (label: string) => call<void>("pin_ready", { label });
export const pinClose = (label: string) => call<void>("pin_close", { label });

export interface OcrWordBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ThumbnailAction = "copy" | "quicksave" | "pin" | "edit" | "upload";

export const thumbnailReady = () => call<void>("thumbnail_ready");
/** `discard: true` throws the capture away; `false` (a timeout) lets
 * auto-save keep it. */
export const thumbnailClose = (discard: boolean) => call<void>("thumbnail_close", { discard });
export const thumbnailAction = (action: ThumbnailAction) =>
  call<void>("thumbnail_action", { action });

export async function pinEditorImage(pngBytes: Uint8Array): Promise<void> {
  try {
    await invoke<void>("pin_editor_image", pngBytes);
  } catch (err) {
    throw new IpcError(err);
  }
}

export function parseHashRoute(): { route: string; params: URLSearchParams } {
  const hash = window.location.hash.replace(/^#/, "");
  const [route, query] = hash.split("?");
  return { route: route || "main", params: new URLSearchParams(query ?? "") };
}
