import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Copy,
  Save,
  FolderOpen,
  UploadCloud,
  ChevronDown,
  X,
  Check,
  Loader2,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  fetchShotImage,
  takePendingShapes,
  editorHide,
  editorReady,
  frontendMounted,
  onEditorImage,
  exportPrepare,
  exportCommit,
  ocrExtract,
  ocrBoxes,
  detectFaces,
  type OcrWordBox,
  qrDecode,
  translateText,
  translateServiceAvailable,
  ocrListLangs,
  ocrDownloadLang,
  ocrEngineStatus,
  type OcrEngineStatus,
  getSettings,
  uploadImage,
  pinEditorImage,
  copyTextToClipboard,
  loadImageFile,
  openImageFile,
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
import { findPii } from "./tools/redact";
import { applyAdjustments } from "./tools/adjust";
import { useToast } from "../ui/Toast";
import { ConfirmDialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ResultTabs, type ResultTab } from "../ui/ResultTabs";
import { OcrMissingDialog } from "../ui/OcrMissingDialog";
import { DropdownMenu } from "radix-ui";
import { moveShape } from "./tools/select";
import { createImageShape } from "./tools/image";
import type { ImgPoint, Shape, ToolId } from "./types";
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

const SNAP_TO_TEXT_STORAGE_KEY = "slickshot:highlightSnapToText";

/** The highlighter's snap preference persists across captures, in
 * localStorage rather than settings -- it's a per-tool habit, and routing it
 * through `set_settings` would re-register every hotkey on each toggle. */
function loadSnapToText(): boolean {
  return localStorage.getItem(SNAP_TO_TEXT_STORAGE_KEY) === "true";
}

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
  g: "stamp",
  z: "loupe",
};

/** Parses the shapes an overlay parked for this session. Malformed JSON
 * loses the annotations rather than the capture -- the image is the thing
 * worth keeping. */
function parsePendingShapes(json: string): Shape[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Shape[]) : [];
  } catch (err) {
    console.error("pending editor shapes were not valid JSON", err);
    return [];
  }
}

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
  const [openGuardOpen, setOpenGuardOpen] = useState(false);
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
  const [redacting, setRedacting] = useState(false);
  const [snapToText, setSnapToTextState] = useState(loadSnapToText);
  // Word boxes handed to Canvas for highlight snapping. Null until they land,
  // which keeps drags freeform rather than blocking on OCR.
  const [textBoxes, setTextBoxes] = useState<OcrWordBox[] | null>(null);
  const wordBoxesRef = useRef<{ imageId: string | null; boxes: OcrWordBox[] } | null>(null);
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
    adjustments,
    resize,
    setImage,
    setTool,
    setStyle,
    setBackdrop,
    setResize,
    undo,
    redo,
    addShape,
    addShapes,
    removeShape,
    duplicateSelected,
    updateShape,
    setZoom,
    setCropRect,
    applyCrop,
    setOcrRect,
    setMeasureLine,
    setAdjustments,
    flipImage,
    panelOverride,
    setPanelOverride,
  } = useEditorStore();

  const adjustOpen = panelOverride === "adjust";
  const backdropOpen = panelOverride === "backdrop";

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

  // `take_pending_shapes` is one-shot: it clears the state as it reads it. The
  // effect below can run more than once for the same image -- StrictMode
  // double-invokes it on mount, and the cold-start path mounts with the image
  // already set from the URL -- and a second, unguarded drain would come back
  // empty and wipe the annotations the first one fetched. Caching the promise
  // per image id means every invocation awaits the same single drain.
  const drainRef = useRef<{ id: string; shapes: Promise<string> } | null>(null);
  const pendingShapesOnce = useCallback((id: string): Promise<string> => {
    if (drainRef.current?.id !== id) {
      drainRef.current = { id, shapes: takePendingShapes().catch(() => "") };
    }
    return drainRef.current.shapes;
  }, []);

  useEffect(() => {
    if (!imageId) return;
    setResultTab("origin");
    let stale = false;
    // Drained alongside the image, not after it: `setImage` resets the
    // canvas, so seeding the shapes in the same call is what keeps them from
    // being wiped by their own arrival.
    Promise.all([fetchShotImage(imageId), pendingShapesOnce(imageId)])
      .then(([bitmap, shapesJson]) => {
        if (stale) return;
        setImage(imageId, bitmap.width, bitmap.height, parsePendingShapes(shapesJson));
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
  }, [imageId, setImage, pendingShapesOnce]);

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
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleOpenImage();
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
    handleOpenImage,
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

  // The saved default scale seeds the resize for each new capture, so a
  // standing "always export at 50%" preference still applies -- but from
  // then on the Adjust panel edits real pixel dimensions. Read fresh per
  // capture, since this window is pre-warmed and reused.
  useEffect(() => {
    if (!imageWidth || !imageHeight) return;
    getSettings()
      .then((s) => {
        const percent = s.export_scale;
        setResize(
          percent === 100
            ? null
            : { w: Math.round((imageWidth * percent) / 100), h: Math.round((imageHeight * percent) / 100) },
        );
      })
      .catch(() => {});
  }, [imageId, imageWidth, imageHeight, setResize]);

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

  /** The base pixels an export should composite against: the raw capture
   * with the *current* adjustments applied.
   *
   * Deliberately re-derived from the source bitmap rather than reusing the
   * on-screen canvas. That canvas already carries the adjustments, so reusing
   * it would be right most of the time -- but its sharpness pass is debounced
   * behind the slider, so an export fired mid-drag would save a frame the
   * user has already moved past. Re-deriving here guarantees the file matches
   * the settings, not the paint timing.
   */
  function exportBase(): HTMLCanvasElement | null {
    const canvases = getCanvases();
    if (!canvases) return null;
    if (!baseImage) return canvases.base;
    const raw = document.createElement("canvas");
    raw.width = canvases.base.width;
    raw.height = canvases.base.height;
    raw.getContext("2d")!.drawImage(baseImage, 0, 0);
    return applyAdjustments(raw, adjustments);
  }

  /** Flatten options shared by every full-image export (copy, save, upload,
   * pin) -- OCR passes its own, since it wants the raw region without the
   * backdrop or a scale applied. */
  function exportOptions() {
    return { cropRect, backdrop, target: resize };
  }

  async function doExport(action: Parameters<typeof exportPrepare>[0]) {
    const canvases = getCanvases();
    if (!canvases) return;
    setExporting(true);
    try {
      const bytes = await flattenToPng(exportBase() ?? canvases.base, shapes, exportOptions());
      // Attached here rather than at each call site: every save path already
      // flattens the same `shapes`, and history wants them alongside the
      // base image so the entry reopens editable.
      await exportPrepare(
        action.kind === "clipboard"
          ? action
          : { ...action, shapes: shapes.length > 0 ? JSON.stringify(shapes) : undefined },
      );
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
      const bytes = await flattenToPng(exportBase() ?? canvases.base, shapes, exportOptions());
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
      const bytes = await flattenToPng(exportBase() ?? canvases.base, shapes, exportOptions());
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

  /** Word boxes for the current capture, fetched once and reused: OCR is the
   * expensive part of both auto-redaction and highlighter text-snapping, and
   * the base image doesn't change between them. Cleared when the image does. */
  async function getWordBoxes(): Promise<OcrWordBox[]> {
    const canvases = getCanvases();
    if (!canvases) return [];
    const cached = wordBoxesRef.current;
    if (cached && cached.imageId === imageId) return cached.boxes;

    // Boxes must be in image space, so this deliberately skips crop, backdrop
    // and scale -- the shapes built from them are positioned in image space.
    const bytes = await flattenToPng(canvases.base, []);
    const boxes = await ocrBoxes(bytes);
    wordBoxesRef.current = { imageId, boxes };
    return boxes;
  }

  function setSnapToText(next: boolean) {
    setSnapToTextState(next);
    localStorage.setItem(SNAP_TO_TEXT_STORAGE_KEY, String(next));
  }

  // Boxes are fetched when the highlighter is armed with snapping on, not on
  // first drag: OCR takes long enough that doing it mid-gesture would make
  // the first highlight of each image feel like it hung.
  useEffect(() => {
    if (tool !== "highlight" || !snapToText) return;
    if (ocrStatus !== null && !ocrStatus.available) return;
    if (wordBoxesRef.current?.imageId === imageId) {
      setTextBoxes(wordBoxesRef.current.boxes);
      return;
    }
    let stale = false;
    getWordBoxes()
      .then((boxes) => {
        if (!stale) setTextBoxes(boxes);
      })
      .catch(() => {
        // Snapping simply stays off for this image; the freeform highlight
        // still works, so there is nothing worth interrupting the user for.
        if (!stale) setTextBoxes(null);
      });
    return () => {
      stale = true;
    };
  }, [tool, snapToText, imageId, ocrStatus]);

  /** Mirrors the base bitmap to match `flipImage`'s shape mirroring, so the
   * flip is visible on the canvas immediately rather than only at export. */
  async function handleFlip(axis: "h" | "v") {
    if (!baseImage) return;
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(axis === "h" ? imageWidth : 0, axis === "v" ? imageHeight : 0);
    ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1);
    ctx.drawImage(baseImage, 0, 0);
    const mirrored = await createImageBitmap(canvas);
    flipImage(axis);
    setBaseImage(mirrored);
    // Boxes were measured against the pre-flip image; keeping them would put
    // redactions on the wrong side.
    wordBoxesRef.current = null;
  }

  async function handleRedactPii() {
    if (ocrStatus !== null && !ocrStatus.available) {
      setOcrMissingOpen(true);
      return;
    }
    setRedacting(true);
    try {
      const matches = findPii(await getWordBoxes());
      if (matches.length === 0) {
        toast.show({ kind: "success", title: "No personal data found" });
        return;
      }
      // Padding: OCR boxes hug the glyphs, and a censor that stops exactly at
      // the ink can leave readable fragments at the edges.
      const pad = 2;
      addShapes(
        matches.map((m) => ({
          id: crypto.randomUUID(),
          kind: "pixelate" as const,
          x: m.x - pad,
          y: m.y - pad,
          w: m.w + pad * 2,
          h: m.h + pad * 2,
          blockSize: style.pixelateBlock,
          // Solid regardless of the current censor mode: redaction should be
          // unambiguous, and a pixelated short string can still be guessable.
          mode: "solid" as const,
          color: style.censorColor,
        })),
      );
      toast.show({
        kind: "success",
        title: `Redacted ${matches.length} item${matches.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't redact", description: String(err) });
    } finally {
      setRedacting(false);
    }
  }

  async function handleCensorFaces() {
    const canvases = getCanvases();
    if (!canvases) return;
    setRedacting(true);
    try {
      const bytes = await flattenToPng(canvases.base, []);
      const faces = await detectFaces(bytes);
      if (faces.length === 0) {
        toast.show({ kind: "success", title: "No faces found" });
        return;
      }
      // Detectors bound the face tightly; widening keeps hair and chin in.
      addShapes(
        faces.map((f) => {
          const padX = Math.round(f.w * 0.15);
          const padY = Math.round(f.h * 0.15);
          return {
            id: crypto.randomUUID(),
            kind: "pixelate" as const,
            x: f.x - padX,
            y: f.y - padY,
            w: f.w + padX * 2,
            h: f.h + padY * 2,
            // Scaled to the face rather than taken from the slider: that
            // default is sized for screenshot text, and on a large portrait
            // it leaves the face plainly recognizable. Roughly a dozen
            // blocks across the face is unreadable at any size, and the
            // slider's value still acts as a floor.
            blockSize: Math.max(style.pixelateBlock, Math.round(Math.min(f.w, f.h) / 12)),
            mode: style.censorMode,
            color: style.censorColor,
          };
        }),
      );
      toast.show({
        kind: "success",
        title: `Censored ${faces.length} face${faces.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't detect faces", description: String(err) });
    } finally {
      setRedacting(false);
    }
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

  /** Swaps the whole editing session over to another image file. Goes through
   * `open_image_file`, which stores the decoded image and re-emits
   * `editor:image` at this same pre-warmed window -- the existing
   * `onEditorImage` listener then repaints and `setImage` clears shapes,
   * history and the dirty flag, so this needs no teardown of its own. */
  async function openAnotherImage() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (typeof path !== "string") return;
    try {
      await openImageFile(path);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't open image", description: String(err) });
    }
  }

  function handleOpenImage() {
    // Same guard as closing: replacing the image discards every annotation,
    // so unsaved work gets a confirmation first.
    if (useEditorStore.getState().dirty) {
      setOpenGuardOpen(true);
      return;
    }
    openAnotherImage();
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
        { name: "WebP", extensions: ["webp"] },
        { name: "AVIF", extensions: ["avif"] },
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
        onInsertImage={handleInsertImage}
        onToggleBackdrop={() => {
          // Enabling a backdrop is a request to style it, so the panel comes
          // with it; disabling hands the panel back rather than leaving the
          // options for something that is no longer drawn.
          const enabled = !backdrop.enabled;
          setBackdrop({ enabled });
          setPanelOverride(enabled ? "backdrop" : null);
        }}
        backdropEnabled={backdrop.enabled}
        ocrUnavailable={ocrStatus !== null && !ocrStatus.available}
        onToggleAdjust={() => setPanelOverride(adjustOpen ? null : "adjust")}
        adjustOpen={adjustOpen}
        onRedactPii={handleRedactPii}
        onCensorFaces={handleCensorFaces}
        busy={redacting}
        onPin={doPin}
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
        {/* Centred with the child's `m-auto`, not `items-center
            justify-center`: those overflow a too-large child equally in both
            directions, and the half that spills past the container's *start*
            edge cannot be scrolled to -- zoom in and the top and left of the
            image become unreachable. Auto margins collapse to zero once the
            child no longer fits, so it scrolls from its true top-left. */}
        <div className="flex-1 overflow-auto flex p-6" ref={baseCanvasQuery}>
          <Canvas
            baseImage={baseImage}
            onCursorMove={setCursor}
            onOcrRegion={handleOcrRegion}
            onPickColor={(rgb, screenX, screenY) => setColorPopover({ rgb, screenX, screenY })}
            onConfirmCrop={applyCropConfirm}
            snapToText={snapToText}
            textBoxes={textBoxes}
          />
        </div>
        <PropertiesPanel
          tool={tool}
          style={style}
          onChange={setStyle}
          adjustments={adjustments}
          onAdjustmentsChange={setAdjustments}
          onFlip={handleFlip}
          adjustOpen={adjustOpen}
          backdropOpen={backdropOpen}
          imageWidth={cropRect ? Math.round(cropRect.w) : imageWidth}
          imageHeight={cropRect ? Math.round(cropRect.h) : imageHeight}
          resize={resize}
          onResizeChange={setResize}
          snapToText={snapToText}
          onSnapToTextChange={setSnapToText}
          ocrUnavailable={ocrStatus !== null && !ocrStatus.available}
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
          {/* Grouped with the export actions rather than the toolbar: this
              swaps the whole document, so it belongs with the other
              session-level I/O (Pin, Copy/Save/Upload), not with the
              annotation tools. `Insert image` stays in the toolbar since it
              adds a shape to the current document instead of replacing it. */}
          <IconButton
            label="Open image…"
            shortcut="Ctrl+O"
            icon={<FolderOpen size={16} />}
            onClick={handleOpenImage}
          />
          <IconButton
            label="Undo"
            shortcut="Ctrl+Z"
            icon={<Undo2 size={16} />}
            onClick={undo}
            disabled={past.length === 0}
          />
          <IconButton
            label="Redo"
            shortcut="Ctrl+Shift+Z"
            icon={<Redo2 size={16} />}
            onClick={redo}
            disabled={future.length === 0}
          />
          <div className="w-px h-5 bg-[var(--border)] mx-1" />
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

      <ConfirmDialog
        open={openGuardOpen}
        onOpenChange={setOpenGuardOpen}
        title="Discard changes?"
        description="Opening another image will discard your annotations."
        confirmLabel="Discard"
        danger
        onConfirm={openAnotherImage}
      />
    </div>
  );
}
