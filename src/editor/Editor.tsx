import { useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Save, FolderOpen, UploadCloud, Pin, ChevronDown, X, Check, Loader2 } from "lucide-react";
import {
  fetchShotImage,
  editorHide,
  editorReady,
  frontendMounted,
  onEditorImage,
  exportPrepare,
  exportCommit,
  ocrExtract,
  qrDecode,
  translateText,
  translateServiceAvailable,
  ocrListLangs,
  ocrDownloadLang,
  ocrEngineStatus,
  type OcrEngineStatus,
  getSettings,
  setSettings,
  uploadImage,
  pinEditorImage,
  copyTextToClipboard,
  loadImageFile,
  readClipboardImage,
  releaseImage,
  ISO_TO_OCR_LANG,
  normalizeDetectedLang,
} from "../lib/ipc";
import { useEditorStore } from "./store";
import { Canvas } from "./Canvas";
import { Toolbar } from "./Toolbar";
import { PropertiesPanel } from "./PropertiesPanel";
import { StatusBar } from "./StatusBar";
import { flattenToPng } from "./export";
import { useToast } from "../ui/Toast";
import { ConfirmDialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ResultTabs, type ResultTab } from "../ui/ResultTabs";
import { OcrMissingDialog } from "../ui/OcrMissingDialog";
import { DropdownMenu } from "radix-ui";
import { moveShape } from "./tools/select";
import { createImageShape } from "./tools/image";
import { Select } from "../ui/Select";
import { Tooltip } from "../ui/Tooltip";
import type { ImgPoint, ToolId } from "./types";
import { COLOR_FORMATS, formatColor, measurementLabel, type Rgb } from "../lib/color";
import { PixelLoupe, SAMPLE_PX } from "../ui/PixelLoupe";
import type { PhysRect } from "../lib/geometry";

interface OcrPopoverState {
  screenX: number;
  screenY: number;
  loading: boolean;
  text: string;
  error: string | null;
  translateEnabled: boolean;
  translateLang: string;
  translating: boolean;
  translated: string | null;
  translateError: string | null;
  truncated: boolean;
  detectedLang: string | null;
  /** Payloads of any QR codes found in the same region. */
  qrCodes: string[];
}

interface EditorProps {
  params: URLSearchParams;
}

/** Scale that fits the image inside `container` without cropping, never
 * upscaling past 100% -- shared by the initial mount-time fit and the
 * status bar's fit/actual-size toggle so they can't drift out of sync. */
function computeFitZoom(container: HTMLElement, imageWidth: number, imageHeight: number): number {
  const scale = Math.min(
    (container.clientWidth - 48) / imageWidth,
    (container.clientHeight - 48) / imageHeight,
    1,
  );
  return Math.max(scale, 0.05);
}

type ExportDefaultAction = "clipboard" | "save" | "quicksave" | "upload";
const EXPORT_DEFAULT_STORAGE_KEY = "slickshot:exportDefaultAction";

function loadExportDefaultAction(): ExportDefaultAction {
  const stored = localStorage.getItem(EXPORT_DEFAULT_STORAGE_KEY);
  return stored === "save" || stored === "quicksave" || stored === "upload" ? stored : "clipboard";
}

const SHORTCUT_TOOLS: Record<string, ToolId> = {
  v: "select",
  r: "rect",
  e: "ellipse",
  a: "arrow",
  l: "line",
  p: "freehand",
  t: "text",
  h: "highlight",
  x: "pixelate",
  w: "spotlight",
  m: "marker",
  c: "crop",
  o: "ocr",
  i: "eyedropper",
  u: "measure",
};

export function Editor({ params }: EditorProps) {
  // The window is pre-warmed and reused across captures (see `editor::show`
  // in Rust): each capture arrives as an `editor:image` event. The URL param
  // only seeds a freshly (re)built window, whose JS wasn't loaded yet when
  // the event fired.
  const [imageId, setImageId] = useState<string | null>(params.get("image"));
  const [baseImage, setBaseImage] = useState<ImageBitmap | null>(null);
  const [cursor, setCursor] = useState<{
    img: ImgPoint;
    clientX: number;
    clientY: number;
    rgb: Rgb | null;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [ocrPopover, setOcrPopover] = useState<OcrPopoverState | null>(null);
  const [colorPopover, setColorPopover] = useState<{ screenX: number; screenY: number; rgb: Rgb } | null>(null);
  // Sticky across repeated OCR extractions in the same editor session: once
  // the user switches to Translation, the next extraction opens there too
  // instead of resetting to Original every time. Reset to "origin" whenever
  // a new capture replaces the image (see the imageId-keyed effect below).
  const [resultTab, setResultTab] = useState<ResultTab>("origin");
  const [installedLangs, setInstalledLangs] = useState<string[]>([]);
  const [downloadingLang, setDownloadingLang] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<OcrEngineStatus | null>(null);
  const [ocrMissingOpen, setOcrMissingOpen] = useState(false);
  const lastOcrRectRef = useRef<PhysRect | null>(null);
  // Checked once whenever the "Extract text" tool is (re-)activated -- see
  // the `tool === "ocr"` effect below -- not per drag-selected region.
  // Defaults to true so the first region after activating isn't held back
  // by the check still in flight.
  const primaryAvailableRef = useRef(true);
  const [exportDefault, setExportDefaultState] = useState<ExportDefaultAction>(loadExportDefaultAction);
  const baseCanvasQuery = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const {
    imageWidth,
    imageHeight,
    tool,
    style,
    zoom,
    shapes,
    past,
    future,
    selectedId,
    cropRect,
    measureLine,
    backdrop,
    exportScale,
    setImage,
    setTool,
    setStyle,
    setBackdrop,
    setExportScale,
    undo,
    redo,
    addShape,
    removeShape,
    duplicateSelected,
    updateShape,
    setZoom,
    setCropRect,
    applyCrop,
    setOcrRect,
    setMeasureLine,
  } = useEditorStore();

  useEffect(() => {
    const unlisten = onEditorImage(setImageId);
    unlisten.then(() => frontendMounted());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Re-checked (not cached) on every mount: this window is pre-warmed and
  // reused across captures, and installing Tesseract mid-session should
  // unlock OCR without an app restart.
  useEffect(() => {
    ocrEngineStatus()
      .then(setOcrStatus)
      .catch(() => {});
  }, []);

  /** Routes tool switches through the Tesseract-availability check: picking
   * "ocr" while it's unavailable opens install guidance instead of arming
   * region-drag. Shared by the toolbar click and the "O" keyboard shortcut. */
  function handleToolChange(next: ToolId) {
    if (next === "ocr" && ocrStatus && !ocrStatus.available) {
      setOcrMissingOpen(true);
      return;
    }
    setTool(next);
  }

  useEffect(() => {
    if (!imageId) return;
    setResultTab("origin");
    let stale = false;
    fetchShotImage(imageId)
      .then((bitmap) => {
        if (stale) return;
        setImage(imageId, bitmap.width, bitmap.height);
        setBaseImage(bitmap);
      })
      .catch((err) => {
        // The window is only shown once we report ready; a failed load
        // would leave it invisible while holding the image, so dismiss.
        console.error("editor image load failed", err);
        if (!stale) editorHide();
      });
    return () => {
      stale = true;
    };
  }, [imageId, setImage]);

  // Signals Rust to show the window. As the parent, this effect runs after
  // Canvas's effects on the same commit -- i.e. after the capture has been
  // drawn -- so showing the window can't flash blank or stale content.
  useEffect(() => {
    if (baseImage) editorReady();
  }, [baseImage]);

  useEffect(() => {
    if (imageWidth === 0) return;
    const container = baseCanvasQuery.current;
    if (!container) return;
    const fit = () => setZoom(computeFitZoom(container, imageWidth, imageHeight));
    fit();

    // The editor window is pre-warmed and hidden until the capture is
    // drawn (see `editor::show` in Rust), so on the very first open this
    // effect can run before the window's real layout has settled --
    // `container` briefly measures near its pre-paint size, producing a
    // much-too-small fit zoom. Re-fit once the container's actual size
    // lands, then stop watching so this doesn't fight a manual zoom change
    // on a later window resize.
    const ro = new ResizeObserver(() => {
      fit();
      ro.disconnect();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [imageWidth, imageHeight, setZoom]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        doExport({ kind: "clipboard" });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveAs();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doExport({ kind: "quicksave" });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        doUpload();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        doPin();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        // Handled here rather than through a `paste` listener: WebKitGTK
        // only fires paste events at an editable target, so pasting onto
        // the canvas never reached the page. Text-field pastes still go the
        // native route -- the TEXTAREA/INPUT guard above returns early.
        e.preventDefault();
        pasteClipboardImage();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        removeShape(selectedId);
        return;
      }
      if (selectedId && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const shape = shapes.find((s) => s.id === selectedId);
        if (shape) {
          updateShape(selectedId, moveShape(shape, dx, dy));
        }
        return;
      }
      if (tool === "crop" && e.key === "Enter") {
        applyCropConfirm();
        return;
      }
      if (tool === "crop" && e.key === "Escape") {
        setCropRect(null);
        setTool("select");
        return;
      }
      if (e.key === "Escape" && colorPopover) {
        setColorPopover(null);
        return;
      }
      if (e.key === "Escape" && tool === "measure" && measureLine) {
        setMeasureLine(null);
        return;
      }
      if (e.key === "Escape" && ocrPopover) {
        setOcrPopover(null);
        setOcrRect(null);
        return;
      }

      if (e.ctrlKey || e.metaKey) return;
      const mapped = SHORTCUT_TOOLS[e.key.toLowerCase()];
      if (mapped) handleToolChange(mapped);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    selectedId,
    shapes,
    tool,
    cropRect,
    ocrPopover,
    colorPopover,
    measureLine,
    setMeasureLine,
    undo,
    redo,
    duplicateSelected,
    removeShape,
    updateShape,
    setTool,
    setCropRect,
    applyCropConfirm,
    setOcrRect,
    doExport,
    handleSaveAs,
    doUpload,
    doPin,
    handleToolChange,
  ]);

  // Probed once each time the "Extract text" tool is (re-)activated (button
  // click or the `O` shortcut above) -- not per drag-selected region -- so a
  // whole session of regions reuses this one result instead of re-hitting a
  // known-blocked primary translation endpoint on every single one. Skipped
  // when translation is off, since no translate call will happen this
  // session anyway (OCR still runs regardless -- only translation is gated).
  useEffect(() => {
    if (tool === "ocr") {
      getSettings()
        .then((s) => {
          if (!s.translate_enabled) return;
          return translateServiceAvailable().then((available) => {
            primaryAvailableRef.current = available;
          });
        })
        .catch(() => {
          primaryAvailableRef.current = true;
        });
    }
  }, [tool]);

  // The export scale lives in settings so it survives a restart, but the
  // store owns it during a session. Read fresh per capture (this window is
  // pre-warmed and reused) rather than once at mount.
  useEffect(() => {
    getSettings()
      .then((s) => setExportScale(s.export_scale))
      .catch(() => {});
  }, [imageId, setExportScale]);

  useEffect(() => {
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [zoom, setZoom]);

  useEffect(() => {
    const w = getCurrentWindow();
    // Read live state, not a closure-captured `dirty`: this listener is
    // registered once (empty deps) so it never goes stale.
    //
    // The real close is ALWAYS prevented: this window is pre-warmed and
    // reused across captures (see `editor::show` in Rust), so destroying it
    // would force a full webview + JS bundle rebuild on the next capture.
    // Dismissing the editor means hiding it via `editor_hide`, which also
    // frees the shown image on the Rust side.
    const unlisten = w.onCloseRequested(async (event) => {
      event.preventDefault();
      if (useEditorStore.getState().dirty) {
        setCloseGuardOpen(true);
      } else {
        editorHide();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  function getCanvases(): { base: HTMLCanvasElement; ann: HTMLCanvasElement } | null {
    const wrapper = baseCanvasQuery.current;
    if (!wrapper) return null;
    const canvases = wrapper.querySelectorAll("canvas");
    if (canvases.length < 2) return null;
    return { base: canvases[0] as HTMLCanvasElement, ann: canvases[1] as HTMLCanvasElement };
  }

  /** Flatten options shared by every full-image export (copy, save, upload,
   * pin) -- OCR passes its own, since it wants the raw region without the
   * backdrop or a scale applied. */
  function exportOptions() {
    return { cropRect, backdrop, scalePercent: exportScale };
  }

  async function doExport(action: Parameters<typeof exportPrepare>[0]) {
    const canvases = getCanvases();
    if (!canvases) return;
    setExporting(true);
    try {
      const bytes = await flattenToPng(canvases.base, shapes, exportOptions());
      await exportPrepare(action);
      const result = await exportCommit(bytes);
      if (action.kind === "clipboard") {
        toast.show({ kind: "success", title: "Copied to clipboard" });
      } else if (result.saved_path) {
        toast.show({
          kind: "success",
          title: "Screenshot saved",
          description: result.saved_path,
          actionLabel: "Show in folder",
          onAction: () => revealItemInDir(result.saved_path!),
        });
      }
      useEditorStore.setState({ dirty: false });
    } catch (err) {
      toast.show({ kind: "error", title: "Export failed", description: String(err) });
    } finally {
      setExporting(false);
    }
  }

  async function doUpload() {
    const canvases = getCanvases();
    if (!canvases) return;
    setExporting(true);
    try {
      const bytes = await flattenToPng(canvases.base, shapes, exportOptions());
      const result = await uploadImage(bytes);
      await copyTextToClipboard(result.url);
      toast.show({
        kind: "success",
        title: "Uploaded — link copied",
        description: result.url,
        actionLabel: "Open",
        onAction: () => openUrl(result.url),
      });
      useEditorStore.setState({ dirty: false });
    } catch (err) {
      toast.show({ kind: "error", title: "Upload failed", description: String(err) });
    } finally {
      setExporting(false);
    }
  }

  async function doPin() {
    const canvases = getCanvases();
    if (!canvases) return;
    try {
      const bytes = await flattenToPng(canvases.base, shapes, exportOptions());
      await pinEditorImage(bytes);
      toast.show({ kind: "success", title: "Pinned to screen" });
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't pin to screen", description: String(err) });
    }
  }

  /** Bakes the pending crop rect into the image: renders the cropped region
   * of the current base image into a new bitmap, then hands the store the
   * same rect so it can shift shapes and shrink imageWidth/imageHeight to
   * match. Without this, "confirming" a crop only ever affected the final
   * exported PNG -- the editor canvas kept showing the full, uncropped
   * image with just a passive outline around the selected region. */
  async function applyCropConfirm() {
    const rect = useEditorStore.getState().cropRect;
    if (!rect || !baseImage) {
      setTool("select");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.w);
    canvas.height = Math.round(rect.h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(baseImage, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const cropped = await createImageBitmap(canvas);
    applyCrop(rect);
    setBaseImage(cropped);
    setTool("select");
  }

  async function handleOcrRegion(rect: PhysRect) {
    const canvases = getCanvases();
    if (!canvases) return;
    lastOcrRectRef.current = rect;

    const canvasRect = canvases.ann.getBoundingClientRect();
    const sx = canvasRect.width / imageWidth;
    const sy = canvasRect.height / imageHeight;
    const POPOVER_W = 320;
    const POPOVER_H = 220;
    const MARGIN = 8;
    const rawX = canvasRect.left + rect.x * sx;
    const belowY = canvasRect.top + (rect.y + rect.h) * sy + MARGIN;
    const aboveY = canvasRect.top + rect.y * sy - POPOVER_H - MARGIN;
    const screenX = Math.min(Math.max(rawX, MARGIN), window.innerWidth - POPOVER_W - MARGIN);
    const screenY = belowY + POPOVER_H + MARGIN > window.innerHeight && aboveY >= MARGIN ? aboveY : belowY;

    // Read translate_enabled fresh each time rather than caching at mount:
    // this window is pre-warmed and reused across captures, and the user
    // could flip the setting between captures in a session that never
    // remounts this component.
    const settings = await getSettings().catch(() => null);
    const translateEnabled = settings?.translate_enabled ?? false;
    const translateLang = settings?.translate_target ?? "en";

    setOcrPopover({
      screenX,
      screenY,
      loading: true,
      text: "",
      error: null,
      translateEnabled,
      translateLang,
      translating: false,
      translated: null,
      translateError: null,
      truncated: false,
      detectedLang: null,
      qrCodes: [],
    });
    try {
      const bytes = await flattenToPng(canvases.base, shapes, { cropRect: rect });
      // QR decoding runs alongside OCR on the same crop; a failure there is
      // logged and dropped rather than surfaced, since text extraction --
      // the thing actually asked for -- can still succeed.
      const qrPromise = qrDecode(bytes).catch((err) => {
        console.error("QR decode failed", err);
        return [] as string[];
      });
      const text = await ocrExtract(bytes);
      const qrCodes = await qrPromise;
      if (!text && qrCodes.length === 0) {
        setOcrPopover((p) => (p ? { ...p, loading: false, error: "No text found in this region." } : p));
        return;
      }
      setOcrPopover((p) => (p ? { ...p, loading: false, text, qrCodes } : p));
      if (!text) return;

      if (translateEnabled) {
        setOcrPopover((p) => (p ? { ...p, translating: true } : p));
        try {
          const result = await translateText(text, primaryAvailableRef.current);
          const langs = await ocrListLangs();
          setInstalledLangs(langs);
          setOcrPopover((p) =>
            p
              ? {
                  ...p,
                  translating: false,
                  translated: result.translated,
                  truncated: result.truncated,
                  detectedLang: normalizeDetectedLang(result.detected_lang),
                }
              : p,
          );
        } catch (err) {
          setOcrPopover((p) => (p ? { ...p, translating: false, translateError: String(err) } : p));
        }
      }
    } catch (err) {
      setOcrPopover((p) => (p ? { ...p, loading: false, error: String(err) } : p));
    }
  }

  async function handleDownloadLang(isoCode: string) {
    setDownloadingLang(true);
    try {
      await ocrDownloadLang(isoCode);
      setInstalledLangs(await ocrListLangs());
      if (lastOcrRectRef.current) await handleOcrRegion(lastOcrRectRef.current);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't download OCR language", description: String(err) });
    } finally {
      setDownloadingLang(false);
    }
  }

  /** Adds `dataUrl` to the canvas as a movable/resizable image shape. */
  async function insertImageFromDataUrl(dataUrl: string) {
    const el = new Image();
    await new Promise<void>((resolve, reject) => {
      el.onload = () => resolve();
      el.onerror = () => reject(new Error("Couldn't decode that image"));
      el.src = dataUrl;
    });
    addShape(
      createImageShape(crypto.randomUUID(), dataUrl, el.naturalWidth, el.naturalHeight, imageWidth, imageHeight),
    );
    setTool("select");
  }

  /** Turns a stored image id into a data URL and inserts it, releasing the
   * store entry either way -- the shape keeps its own copy of the pixels. */
  async function insertStoredImage(imageId: string) {
    try {
      const bitmap = await fetchShotImage(imageId);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      await insertImageFromDataUrl(canvas.toDataURL("image/png"));
    } finally {
      releaseImage(imageId).catch(() => {});
    }
  }

  async function pasteClipboardImage() {
    try {
      const imageId = await readClipboardImage();
      // No image on the clipboard is the ordinary case for a stray Ctrl+V:
      // stay silent rather than popping an error toast.
      if (imageId) await insertStoredImage(imageId);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't paste image", description: String(err) });
    }
  }

  async function handleInsertImage() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (typeof path !== "string") return;
    // Decoding goes through Rust + `slickshot://` rather than a direct file read:
    // the webview has no filesystem access, and this reuses the protocol
    // that already serves capture frames. The store entry is temporary --
    // the shape keeps its own data URL -- so it's released either way.
    try {
      await insertStoredImage(await loadImageFile(path));
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't insert image", description: String(err) });
    }
  }

  function copyMeasurement() {
    if (!measureLine) return;
    copyTextToClipboard(measurementLabel(measureLine.start, measureLine.end)).then(
      () => toast.show({ kind: "success", title: "Measurement copied" }),
      (err) => toast.show({ kind: "error", title: "Copy failed", description: String(err) }),
    );
  }

  function copyColor(text: string) {
    copyTextToClipboard(text).then(
      () => {
        toast.show({ kind: "success", title: `Copied ${text}` });
        setColorPopover(null);
      },
      (err) => toast.show({ kind: "error", title: "Copy failed", description: String(err) }),
    );
  }

  async function handleSaveAs() {
    const path = await saveDialog({
      defaultPath: "Screenshot.png",
      filters: [
        { name: "PNG", extensions: ["png"] },
        { name: "JPEG", extensions: ["jpg", "jpeg"] },
      ],
    });
    if (path) doExport({ kind: "save", path });
  }

  function setExportDefault(action: ExportDefaultAction) {
    setExportDefaultState(action);
    localStorage.setItem(EXPORT_DEFAULT_STORAGE_KEY, action);
  }

  function runExportDefault() {
    if (exportDefault === "save") handleSaveAs();
    else if (exportDefault === "quicksave") doExport({ kind: "quicksave" });
    else if (exportDefault === "upload") doUpload();
    else doExport({ kind: "clipboard" });
  }

  const EXPORT_DEFAULT_LABEL: Record<ExportDefaultAction, string> = {
    clipboard: "Copy",
    save: "Save As…",
    quicksave: "Quick save",
    upload: "Upload",
  };
  const EXPORT_DEFAULT_ICON: Record<ExportDefaultAction, React.ReactNode> = {
    clipboard: <Copy size={14} />,
    save: <Save size={14} />,
    quicksave: <FolderOpen size={14} />,
    upload: <UploadCloud size={14} />,
  };

  if (!imageId || !baseImage) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--surface-2)]">
        <span className="text-sm text-[var(--fg-muted)]">Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--surface-2)]">
      <Toolbar
        tool={tool}
        onToolChange={handleToolChange}
        onUndo={undo}
        onRedo={redo}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onInsertImage={handleInsertImage}
        onToggleBackdrop={() => setBackdrop({ enabled: !backdrop.enabled })}
        backdropEnabled={backdrop.enabled}
        ocrUnavailable={ocrStatus !== null && !ocrStatus.available}
      />
      {ocrStatus && !ocrStatus.available && ocrStatus.install_hint && (
        <OcrMissingDialog
          open={ocrMissingOpen}
          onOpenChange={setOcrMissingOpen}
          installHint={ocrStatus.install_hint}
          onAvailable={() => setOcrStatus({ available: true, install_hint: null })}
        />
      )}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-auto flex items-center justify-center p-6" ref={baseCanvasQuery}>
          <Canvas
            baseImage={baseImage}
            onCursorMove={setCursor}
            onOcrRegion={handleOcrRegion}
            onPickColor={(rgb, screenX, screenY) => setColorPopover({ rgb, screenX, screenY })}
            onConfirmCrop={applyCropConfirm}
          />
        </div>
        <PropertiesPanel
          tool={tool}
          style={style}
          onChange={setStyle}
          selectedShape={selectedId ? shapes.find((s) => s.id === selectedId) ?? null : null}
          onUpdateShape={(shape) => updateShape(shape.id, shape)}
          onDeleteShape={() => selectedId && removeShape(selectedId)}
          backdrop={backdrop}
          onBackdropChange={setBackdrop}
          measureLine={measureLine}
          onCopyMeasurement={copyMeasurement}
        />
      </div>
      <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface)]">
        <StatusBar
          zoom={zoom}
          imageWidth={cropRect ? cropRect.w : imageWidth}
          imageHeight={cropRect ? cropRect.h : imageHeight}
          cursor={cursor?.img ?? null}
          onZoomChange={setZoom}
          onFit={() => {
            if (Math.abs(zoom - 1) < 0.001) {
              const container = baseCanvasQuery.current;
              if (container) setZoom(computeFitZoom(container, imageWidth, imageHeight));
            } else {
              setZoom(1);
            }
          }}
        />
        <div className="flex items-center gap-1 pr-2">
          {/* Wrapped in a span, not passed straight to Tooltip: the trigger
              clones its child and hands it a ref, which `Select` (a plain
              function component) can't receive. */}
          <Tooltip label="Export size — scales the saved image, not the view">
            <span className="inline-flex">
              <Select
                aria-label="Export size"
                size="sm"
                value={String(exportScale)}
                onChange={(value) => {
                  const percent = Number(value);
                  setExportScale(percent);
                  // Persist so the choice survives the next capture and restart.
                  getSettings()
                    .then((s) => setSettings({ ...s, export_scale: percent }))
                    .catch(() => {});
                }}
                options={[
                  { value: "100", label: "100%" },
                  { value: "75", label: "75%" },
                  { value: "50", label: "50%" },
                  { value: "33", label: "33%" },
                ]}
              />
            </span>
          </Tooltip>
          <IconButton label="Pin to screen" shortcut="Ctrl+P" icon={<Pin size={16} />} onClick={doPin} />
          <div className="flex items-center">
            <Button
              variant="flat-accent"
              size="sm"
              icon={EXPORT_DEFAULT_ICON[exportDefault]}
              loading={exporting}
              onClick={runExportDefault}
              className="rounded-r-none"
            >
              {EXPORT_DEFAULT_LABEL[exportDefault]}
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  variant="flat-accent"
                  size="sm"
                  iconOnly
                  icon={<ChevronDown size={14} />}
                  aria-label="More export options"
                  className="rounded-l-none border-l border-l-white/20"
                >
                  {null}
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-50 min-w-[240px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] p-1"
                >
                  <DropdownMenu.Item
                    onSelect={() => {
                      setExportDefault("clipboard");
                      doExport({ kind: "clipboard" });
                    }}
                    className="flex items-center gap-2 px-2.5 h-8 rounded-[var(--radius-sm)] text-sm text-[var(--fg)] outline-none data-[highlighted]:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Copy size={14} />
                    <span className="flex-1">Copy</span>
                    <span className="text-[10px] font-mono text-[var(--fg-muted)]">Ctrl+C</span>
                    {exportDefault === "clipboard" && <Check size={14} className="text-[var(--accent)]" />}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      setExportDefault("save");
                      handleSaveAs();
                    }}
                    className="flex items-center gap-2 px-2.5 h-8 rounded-[var(--radius-sm)] text-sm text-[var(--fg)] outline-none data-[highlighted]:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Save size={14} />
                    <span className="flex-1">Save As…</span>
                    <span className="text-[10px] font-mono text-[var(--fg-muted)]">Ctrl+Shift+S</span>
                    {exportDefault === "save" && <Check size={14} className="text-[var(--accent)]" />}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      setExportDefault("quicksave");
                      doExport({ kind: "quicksave" });
                    }}
                    className="flex items-center gap-2 px-2.5 h-8 rounded-[var(--radius-sm)] text-sm text-[var(--fg)] outline-none data-[highlighted]:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <FolderOpen size={14} />
                    <span className="flex-1">Quick save</span>
                    <span className="text-[10px] font-mono text-[var(--fg-muted)]">Ctrl+S</span>
                    {exportDefault === "quicksave" && <Check size={14} className="text-[var(--accent)]" />}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      setExportDefault("upload");
                      doUpload();
                    }}
                    className="flex items-center gap-2 px-2.5 h-8 rounded-[var(--radius-sm)] text-sm text-[var(--fg)] outline-none data-[highlighted]:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <UploadCloud size={14} />
                    <span className="flex-1">Upload</span>
                    <span className="text-[10px] font-mono text-[var(--fg-muted)]">Ctrl+U</span>
                    {exportDefault === "upload" && <Check size={14} className="text-[var(--accent)]" />}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      </div>

      {ocrPopover && (
        <div
          className="fixed z-50 w-80 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] flex flex-col overflow-hidden"
          style={{ left: ocrPopover.screenX, top: ocrPopover.screenY }}
        >
          <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Extracted text</span>
            <button
              aria-label="Close"
              onClick={() => {
                setOcrPopover(null);
                setOcrRect(null);
              }}
              className="inline-flex items-center justify-center w-8 h-8 -m-1.5 -mr-1.5 rounded-[var(--radius-sm)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--focus-ring)]"
            >
              <X size={14} />
            </button>
          </div>
          <div className="p-3 flex flex-col gap-3">
            {ocrPopover.qrCodes.length > 0 && (
              <div className="flex flex-col gap-1.5 pb-2 border-b border-[var(--border)]">
                <span className="text-xs font-medium text-[var(--fg-muted)]">
                  QR code{ocrPopover.qrCodes.length > 1 ? "s" : ""}
                </span>
                {ocrPopover.qrCodes.map((payload, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="flex-1 text-xs font-mono text-[var(--fg)] break-all line-clamp-2">
                      {payload}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        copyTextToClipboard(payload).then(
                          () => toast.show({ kind: "success", title: "QR content copied" }),
                          (err) =>
                            toast.show({ kind: "error", title: "Copy failed", description: String(err) }),
                        )
                      }
                    >
                      Copy
                    </Button>
                    {/^https?:\/\//i.test(payload) && (
                      <Button size="sm" variant="secondary" onClick={() => openUrl(payload)}>
                        Open
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {ocrPopover.loading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
                <Loader2 size={14} className="animate-spin" /> Reading text…
              </div>
            ) : ocrPopover.error ? (
              <p className="text-sm text-[var(--danger)]">{ocrPopover.error}</p>
            ) : !ocrPopover.text ? (
              <p className="text-sm text-[var(--fg-muted)]">No text found in this region.</p>
            ) : (
              <ResultTabs
                tab={resultTab}
                onTabChange={setResultTab}
                origin={ocrPopover.text}
                enabled={ocrPopover.translateEnabled}
                originLang={ocrPopover.detectedLang ?? ocrPopover.translateLang}
                translateLang={ocrPopover.translateLang}
                translated={ocrPopover.translated}
                translating={ocrPopover.translating}
                translateError={ocrPopover.translateError}
                truncated={ocrPopover.truncated}
                downloadingLang={downloadingLang}
                missingLang={
                  ocrPopover.detectedLang && ISO_TO_OCR_LANG[ocrPopover.detectedLang] &&
                  !installedLangs.includes(ISO_TO_OCR_LANG[ocrPopover.detectedLang].code)
                    ? { isoCode: ocrPopover.detectedLang, label: ISO_TO_OCR_LANG[ocrPopover.detectedLang].label }
                    : null
                }
                onDownloadLang={handleDownloadLang}
              />
            )}
          </div>
        </div>
      )}

      {tool === "eyedropper" && cursor && !colorPopover && (() => {
        const canvases = getCanvases();
        const half = (SAMPLE_PX - 1) / 2;
        return (
          <PixelLoupe
            fixed
            sources={[canvases?.base ?? null, canvases?.ann ?? null]}
            sourceX={Math.floor(cursor.img.x) - half}
            sourceY={Math.floor(cursor.img.y) - half}
            cssX={cursor.clientX}
            cssY={cursor.clientY}
            containerWidth={window.innerWidth}
            containerHeight={window.innerHeight}
            color={cursor.rgb}
            format="hex"
            caption={`${Math.floor(cursor.img.x)}, ${Math.floor(cursor.img.y)}`}
          />
        );
      })()}

      {colorPopover && (
        <div
          className="fixed z-50 w-52 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] overflow-hidden"
          // Clamped so a pick near the right/bottom edge doesn't render the
          // card off-window, the same guard the OCR popover uses.
          style={{
            left: Math.min(colorPopover.screenX + 12, window.innerWidth - 208 - 8),
            top: Math.min(colorPopover.screenY + 12, window.innerHeight - 168 - 8),
          }}
        >
          <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <span
                className="w-4 h-4 rounded-[3px] border border-[var(--border)]"
                style={{ background: formatColor(colorPopover.rgb, "hex") }}
              />
              <span className="text-xs font-medium text-[var(--fg-muted)]">Picked color</span>
            </div>
            <button
              aria-label="Close"
              onClick={() => setColorPopover(null)}
              className="inline-flex items-center justify-center w-8 h-8 -m-1.5 -mr-1.5 rounded-[var(--radius-sm)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--focus-ring)]"
            >
              <X size={14} />
            </button>
          </div>
          <div className="p-1.5 flex flex-col">
            {COLOR_FORMATS.map((format) => {
              const value = formatColor(colorPopover.rgb, format);
              return (
                <button
                  key={format}
                  type="button"
                  onClick={() => copyColor(value)}
                  title={`Copy ${value}`}
                  className="flex items-center justify-between gap-2 h-8 px-2 rounded-[var(--radius-sm)] text-left hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--focus-ring)]"
                >
                  <span className="text-[11px] font-mono text-[var(--fg)] truncate">{value}</span>
                  <Copy size={12} className="text-[var(--fg-muted)] shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={closeGuardOpen}
        onOpenChange={setCloseGuardOpen}
        title="Discard changes?"
        description="You have unsaved annotations. Closing now will lose them."
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          useEditorStore.setState({ dirty: false });
          editorHide();
        }}
      />
    </div>
  );
}
