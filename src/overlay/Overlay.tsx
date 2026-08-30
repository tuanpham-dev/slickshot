import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Check, Copy, Download, Loader2, Pencil, Pin as PinIcon, X } from "lucide-react";
import {
  listMonitors,
  listWindows,
  onSelectionChanged,
  onOverlayShapes,
  overlaySetShapes,
  releaseImage,
  selectionSetDest,
  selectionRegionImage,
  selectionConfirmAnnotated,
  selectionConfirmToEditor,
  type ConfirmDest,
  type AppSettings,
  selectionBegin,
  selectionCancel,
  selectionConfirm,
  selectionConfirmPin,
  selectionConfirmWindow,
  selectionEnd,
  selectionSetRect,
  selectionUpdate,
  fetchShotImage,
  overlayReady,
  frontendMounted,
  copyTextToClipboard,
  ocrTranslateRegion,
  ocrListLangs,
  ocrDownloadLang,
  getSettings,
  translateServiceAvailable,
  ISO_TO_OCR_LANG,
  normalizeDetectedLang,
  type MonitorInfo,
  type WindowInfo,
} from "../lib/ipc";
import { rectContains, rectFromPoints, rectIntersect, type PhysPoint, type PhysRect } from "../lib/geometry";
import { measurementLabel } from "../lib/color";
import { ResultTabs, type ResultTab } from "../ui/ResultTabs";
import { IconButton } from "../ui/IconButton";
import {
  ASPECT_OPTIONS,
  HANDLES,
  aspectRatio,
  constrainToAspect,
  pickHandle,
  resizeRect,
  snapRectToEdges,
  type AspectId,
  type HandleId,
  type SnapGuide,
} from "./resize";
import {
  COLOR_FORMATS,
  Loupe,
  formatColor,
  samplePixel,
  type ColorFormat,
  type Rgb,
} from "./Loupe";
import { rebaseToRegion, shapesForMonitor, useAnnotations } from "./annotations";
import { pointerIntent } from "./pointer";
import { confirmRoute } from "./confirm";
import { placeCluster } from "./cluster";
import { QuickTools, type QuickToolsPopover } from "./QuickTools";
import { SELECT_TOOL, resolveOverlayTools, type OverlayToolMeta } from "./tools";
import { applyStyleToShape, styleOfShape, toolForShape } from "./style";
import { render } from "../editor/render";
import { flattenToPng } from "../editor/export";
import { DEFAULT_STYLE, isRotatable, type Shape, type Style, type ToolId } from "../editor/types";
import { makeDraft } from "../editor/tools/draft";
import { moveShape, pickShape } from "../editor/tools/select";
import { extendFreehand, startFreehand } from "../editor/tools/freehand";
import { createMarker } from "../editor/tools/marker";
import { createText } from "../editor/tools/text";
import { createStamp, pushRecentStamp } from "../editor/tools/stamp";

interface OverlayProps {
  params: URLSearchParams;
}

interface OverlayFrame {
  image_id: string;
  mode: "region" | "window" | "translate" | "color" | "measure";
  /** Previous capture's region, already clipped to the current screen by
   * Rust. Present only for region mode, and only when there is one. */
  seed_rect: PhysRect | null;
}

/** Cursor position in both spaces: physical for sampling/measuring, CSS for
 * positioning the loupe inside this window. */
interface CursorState {
  phys: PhysPoint;
  cssX: number;
  cssY: number;
}

/** A finished or in-progress measurement, in physical pixels. */
interface Measurement {
  start: PhysPoint;
  end: PhysPoint;
}

/** Pointer travel (physical px) below which a press-release counts as a
 * click rather than a drag -- used to tell "click a window to snap to it"
 * apart from "drag out a region". */
const CLICK_SLOP_PX = 4;

/** Color mode closes the overlay the moment you click, so the confirmation
 * has to come from outside the app's own windows. */
async function sendColorNotification(text: string) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title: "Color copied", body: text });
}



interface TranslatePopoverState {
  loading: boolean;
  origin: string;
  error: string | null;
  translated: string | null;
  truncated: boolean;
  detectedLang: string | null;
}

/** `null` = idle/hovering; "draw" = dragging out a brand new selection from
 * empty space; "move" = dragging the existing selection's body; a HandleId =
 * resizing from that corner/edge. */
type DragMode = "draw" | "move" | HandleId | null;

const HANDLE_HIT_CSS_PX = 12;

const ASPECT_STORAGE_KEY = "slickshot:regionAspect";

/** The aspect lock persists across captures (localStorage, not settings:
 * it's a transient selection preference, and routing it through
 * `set_settings` would re-register every hotkey per change). */
function loadAspect(): AspectId {
  const stored = localStorage.getItem(ASPECT_STORAGE_KEY);
  const match = ASPECT_OPTIONS.find((o) => o.id !== null && o.id === stored);
  return match ? match.id : null;
}

function pct(numerator: number, denominator: number): string {
  return `${(numerator / denominator) * 100}%`;
}

export function Overlay({ params }: OverlayProps) {
  const monitorId = Number(params.get("monitor"));

  const containerRef = useRef<HTMLDivElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [frame, setFrame] = useState<OverlayFrame | null>(null);
  const [selection, setSelection] = useState<PhysRect | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [hoveredWindow, setHoveredWindow] = useState<WindowInfo | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const dragModeRef = useRef<DragMode>(null);
  const dragOrigRectRef = useRef<PhysRect | null>(null);
  const dragStartRef = useRef<PhysPoint | null>(null);
  const [dragMode, setDragMode] = useState<DragMode>(null);

  const [translatePopover, setTranslatePopover] = useState<TranslatePopoverState | null>(null);
  // Read fresh per capture session (not cached) since this window is
  // pre-warmed and reused -- the user could flip the setting between
  // sessions without the overlay ever remounting. Drives both whether
  // ResultTabs shows a Translation tab at all and the mode's hint copy.
  const [translateEnabled, setTranslateEnabled] = useState(false);
  const [translateTarget, setTranslateTarget] = useState("en");
  // Translation mode's whole point is the translated text, so each fresh
  // capture session opens straight to it rather than making the user click
  // past "Original" every time.
  const [resultTab, setResultTab] = useState<ResultTab>("translation");
  const [installedLangs, setInstalledLangs] = useState<string[]>([]);
  const [downloadingLang, setDownloadingLang] = useState(false);
  const lastTranslateRectRef = useRef<PhysRect | null>(null);
  // Checked once when translate mode is entered (see the `overlay:frame`
  // handler below), not per drag-selected region -- defaults to true so the
  // first region in a session isn't held back by the check still in flight.
  const primaryAvailableRef = useRef(true);

  const annotations = useAnnotations();
  // Identity-stable, but read through a ref from the `overlay:frame` listener
  // so that effect keeps its `[monitorId]` dependency list.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  // Bumped when an inserted image finishes decoding, to force one more
  // annotation pass -- image shapes draw nothing on the render that first
  // requests them.
  const [imageTick, setImageTick] = useState(0);
  /** The armed annotation tool, or null when the overlay is a plain region
   * picker. Only ever non-null in region mode. */
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  // Session-local: the overlay never writes back to settings, so a colour
  // picked mid-capture cannot quietly retune what the editor draws.
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const drawStartRef = useRef<PhysPoint | null>(null);
  const drawingRef = useRef(false);
  const [textEdit, setTextEdit] = useState<{ point: PhysPoint; cssX: number; cssY: number } | null>(
    null,
  );
  const [textValue, setTextValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Read per capture session, like the translate settings above: this window
  // is pre-warmed and reused, so the setting can change between captures
  // without it ever remounting.
  const [overlayTools, setOverlayTools] = useState<OverlayToolMeta[]>([]);
  /** What Confirm will do with the capture, read per session like the tools
   * above. Only "editor" changes how annotations travel. */
  const [postCapture, setPostCapture] = useState<AppSettings["post_capture"]>("editor");
  /** The annotation under edit. Set when one is drawn or picked, and what
   * makes the settings dropdown edit *that shape* rather than only the next
   * one drawn. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** A shape mid-drag, rendered in place of its committed self. Kept local so
   * dragging costs one undo step and one broadcast, not one per pointermove. */
  const [liveEdit, setLiveEdit] = useState<Shape | null>(null);
  const shapeDragRef = useRef<{ orig: Shape; start: PhysPoint } | null>(null);
  // Owned here, not inside `QuickTools`, so the Escape handler below can
  // close a popover before it disarms the tool or cancels the capture.
  const [openPopover, setOpenPopover] = useState<QuickToolsPopover | null>(null);

  const [aspect, setAspect] = useState<AspectId>(loadAspect);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [dimDraft, setDimDraft] = useState<{ w: string; h: string } | null>(null);

  const [cursor, setCursor] = useState<CursorState | null>(null);
  const [colorFormat, setColorFormat] = useState<ColorFormat>("hex");
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const measuringRef = useRef(false);
  const pressPointRef = useRef<PhysPoint | null>(null);
  // Cursor updates are coalesced to one per frame: pointermove fires far
  // more often than the loupe can usefully redraw, and each update repaints
  // a magnified crop plus a getImageData read.
  const cursorRafRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<CursorState | null>(null);

  const imageId = frame?.image_id ?? null;
  const pickWindow = frame?.mode === "window";
  const translateMode = frame?.mode === "translate";
  const colorMode = frame?.mode === "color";
  const measureMode = frame?.mode === "measure";
  const regionMode = frame?.mode === "region";

  const scheduleCursor = useCallback((next: CursorState | null) => {
    pendingCursorRef.current = next;
    if (cursorRafRef.current !== null) return;
    cursorRafRef.current = requestAnimationFrame(() => {
      cursorRafRef.current = null;
      setCursor(pendingCursorRef.current);
    });
  }, []);

  useEffect(
    () => () => {
      if (cursorRafRef.current !== null) cancelAnimationFrame(cursorRafRef.current);
    },
    [],
  );

  useEffect(() => {
    listMonitors().then((all) => setMonitor(all.find((m) => m.id === monitorId) ?? null));
  }, [monitorId]);

  // The overlay window is pre-warmed and reused across captures (see
  // `overlay::prewarm` in Rust) rather than rebuilt from scratch each time
  // -- rebuilding meant reloading the whole JS bundle per capture, which was
  // the actual cause of the multi-second blank window before the frozen
  // frame appeared. Each new capture arrives as an event instead of a fresh
  // page load with new URL params.
  useEffect(() => {
    // Scoped to this window's own label: `emit_to` on the Rust side is
    // per-monitor-window, but the JS `listen()` call defaults to accepting
    // an event from *any* target unless told otherwise -- without this,
    // every overlay window's listener fired for every monitor's frame, and
    // whichever `overlay:frame` event was emitted last (chronologically,
    // across all monitors, not just this one) won in every window's React
    // state. That's what made every overlay show the same, single monitor's
    // captured image stretched to fill each window.
    const unlisten = listen<OverlayFrame>(
      "overlay:frame",
      (e) => {
        setImgLoaded(false);
        setSelection(null);
        setHoveredWindow(null);
        setTranslatePopover(null);
        setResultTab("translation");
        dragModeRef.current = null;
        dragOrigRectRef.current = null;
        dragStartRef.current = null;
        setDragMode(null);
        setCursor(null);
        setMeasurement(null);
        measuringRef.current = false;
        pressPointRef.current = null;
        annotationsRef.current.clear();
        setActiveTool(null);
        setSelectedId(null);
        setLiveEdit(null);
        shapeDragRef.current = null;
        setOpenPopover(null);
        setStyle(DEFAULT_STYLE);
        setTextEdit(null);
        setTextValue("");
        drawingRef.current = false;
        drawStartRef.current = null;
        setFrame(e.payload);
        // Pre-select the previous region by pushing it through the normal
        // selection path rather than seeding local state: that is what makes
        // it immediately editable (handles, move, Enter to confirm) and keeps
        // every other overlay window in step via `selection:changed`.
        if (e.payload.seed_rect) selectionSetRect(e.payload.seed_rect);
        // Region mode loads them too: hovering a window there highlights it
        // and a click (rather than a drag) snaps the selection to its bounds.
        if (e.payload.mode === "window" || e.payload.mode === "region") {
          listWindows().then(setWindows);
        }
        if (e.payload.mode === "region") {
          getSettings()
            .then((s) => {
              setOverlayTools(resolveOverlayTools(s.overlay_tools));
              setPostCapture(s.post_capture);
            })
            .catch(() => setOverlayTools([]));
        }
        if (e.payload.mode === "translate") {
          getSettings()
            .then((s) => {
              setTranslateEnabled(s.translate_enabled);
              setTranslateTarget(s.translate_target);
              if (s.translate_enabled) {
                // Probed once per activation of translate mode (not per
                // region -- see `runTranslate`), so a whole session of
                // drag-selected regions reuses this one result instead of
                // re-hitting a known-blocked primary endpoint on every
                // single one. Skipped entirely when translation is off,
                // since no translate call will happen this session anyway.
                translateServiceAvailable()
                  .then((available) => {
                    primaryAvailableRef.current = available;
                  })
                  .catch(() => {
                    primaryAvailableRef.current = true;
                  });
              }
            })
            .catch(() => setTranslateEnabled(false));
        }
      },
      { target: `overlay-${monitorId}` },
    );
    unlisten.then(() => frontendMounted());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [monitorId]);

  // Draws the captured frame into the canvas from raw RGBA bytes fetched
  // off the `slickshot://` protocol -- see `fetchShotImage` for why raw beats
  // the old <img src="slickshot://..."> PNG round trip.
  useEffect(() => {
    if (!imageId) return;
    let stale = false;
    fetchShotImage(imageId)
      .then((bitmap) => {
        const canvas = frameCanvasRef.current;
        if (stale || !canvas) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        setImgLoaded(true);
      })
      .catch((err) => {
        // The window is only shown once we report ready; a failed frame
        // would leave an invisible overlay holding the session open, so
        // tear the whole capture down instead.
        console.error("overlay frame load failed", err);
        if (!stale) handleCancel();
      });
    return () => {
      stale = true;
    };
  }, [imageId]);

  // Annotations are stored in virtual-screen coordinates (matching the
  // selection rect) and drawn into a monitor-sized canvas, so every pass
  // translates by the monitor origin first. Re-runs on any change to the
  // committed list, the in-progress draft, or the frame beneath it.
  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !monitor) return;
    if (canvas.width !== monitor.rect.w || canvas.height !== monitor.rect.h) {
      canvas.width = monitor.rect.w;
      canvas.height = monitor.rect.h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const committed = liveEdit
      ? annotations.shapes.map((s) => (s.id === liveEdit.id ? liveEdit : s))
      : annotations.shapes;
    const all = annotations.draft ? [...committed, annotations.draft] : committed;
    if (all.length === 0) return;
    ctx.save();
    // Clip to the selection: `render()` paints a spotlight's dim across the
    // whole canvas, which here is an entire monitor rather than the captured
    // image. Without the clip a spotlight would dim the desktop outside the
    // region too, on top of the overlay's own mask.
    if (selection) {
      ctx.beginPath();
      ctx.rect(
        selection.x - monitor.rect.x,
        selection.y - monitor.rect.y,
        selection.w,
        selection.h,
      );
      ctx.clip();
    }
    render(ctx, shapesForMonitor(all, monitor.rect), {
      // Monitor-local, matching the translated shapes -- censor and magnifier
      // sample this, so the two spaces have to agree.
      baseImage: imgLoaded ? frameCanvasRef.current : null,
      // Draws the same handles the editor puts on a selected shape.
      selectedId,
      onImageLoad: () => setImageTick((t) => t + 1),
    });
    ctx.restore();
  }, [annotations.shapes, annotations.draft, liveEdit, selectedId, monitor, selection, imgLoaded, imageTick]);

  // Runs on the commit that first renders the mask/hint UI over the drawn
  // frame -- only now is it safe for Rust to show this window (showing any
  // earlier flashed a blank fullscreen window while the frame loaded).
  useEffect(() => {
    if (imgLoaded && imageId) overlayReady(monitorId);
  }, [imgLoaded, imageId, monitorId]);

  // Explicit imperative focus, deferred to a macrotask -- the same treatment
  // the editor's canvas needs (see `Canvas.tsx`). `autoFocus` cannot do this:
  // it focuses synchronously during the pointerdown that opened the field,
  // and the browser's own focus-follows-click settling for that same click
  // lands afterwards on mouseup and takes focus straight back, so the field
  // appears but swallows nothing you type.
  useEffect(() => {
    if (!textEdit) return;
    const id = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [textEdit]);

  useEffect(() => {
    const unlisten = onSelectionChanged((e) => setSelection(e.rect));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Committed shapes are owned by Rust and mirrored here, so a selection
  // spanning two monitors shows the same annotations on both windows. The
  // window that drew them receives its own echo, which is a no-op.
  useEffect(() => {
    const unlisten = onOverlayShapes((json) => {
      try {
        annotationsRef.current.replace(json ? (JSON.parse(json) as Shape[]) : []);
      } catch (err) {
        console.error("overlay shapes payload was not valid JSON", err);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toPhys = useCallback(
    (clientX: number, clientY: number): PhysPoint | null => {
      if (!monitor || !containerRef.current) return null;
      const el = containerRef.current;
      // Scale derived from the window's own size, not devicePixelRatio --
      // correct-by-construction on any platform, see plan Constraints.
      const sx = monitor.rect.w / el.clientWidth;
      const sy = monitor.rect.h / el.clientHeight;
      return {
        x: monitor.rect.x + Math.round(clientX * sx),
        y: monitor.rect.y + Math.round(clientY * sy),
      };
    },
    [monitor],
  );

  async function runTranslate(rect: PhysRect) {
    lastTranslateRectRef.current = rect;
    setTranslatePopover({ loading: true, origin: "", error: null, translated: null, truncated: false, detectedLang: null });
    try {
      const result = await ocrTranslateRegion(rect, primaryAvailableRef.current);
      if (!result.origin) {
        setTranslatePopover((p) => (p ? { ...p, loading: false, error: "No text found in this region." } : p));
        return;
      }
      setInstalledLangs(await ocrListLangs());
      setTranslatePopover((p) =>
        p
          ? {
              ...p,
              loading: false,
              origin: result.origin,
              translated: result.translated,
              truncated: result.truncated,
              detectedLang: normalizeDetectedLang(result.detected_lang),
            }
          : p,
      );
    } catch (err) {
      setTranslatePopover((p) => (p ? { ...p, loading: false, error: String(err) } : p));
    }
  }

  async function handleDownloadLang(isoCode: string) {
    setDownloadingLang(true);
    try {
      await ocrDownloadLang(isoCode);
      setInstalledLangs(await ocrListLangs());
      if (lastTranslateRectRef.current) await runTranslate(lastTranslateRectRef.current);
    } catch (err) {
      setTranslatePopover((p) => (p ? { ...p, error: String(err) } : p));
    } finally {
      setDownloadingLang(false);
    }
  }

  // Clears both the popover AND the underlying selection rect. Clearing
  // only the popover left `selection` (and its Rust-side counterpart's
  // client-side mirror) stale -- a subsequent click landing inside that
  // still-tracked rect was read as "move the existing selection" rather
  // than "start a fresh draw", and `handlePointerUp`'s `translateMode &&
  // finalRect` check fired `runTranslate` again on the same region,
  // reopening the very popover you'd just dismissed.
  function dismissTranslatePopover() {
    setTranslatePopover(null);
    setSelection(null);
  }

  /** Copies the pixel under `p` in the active format and ends the session. */
  async function pickColorAt(p: PhysPoint) {
    const rgb = samplePixel(frameCanvasRef.current, p, monitorOrigin);
    if (!rgb) return;
    const text = formatColor(rgb, colorFormat);
    try {
      // Native clipboard, not navigator.clipboard -- the browser API
      // silently no-ops in this app's WebKitGTK webview on Linux.
      await copyTextToClipboard(text);
      await sendColorNotification(text);
    } catch (err) {
      console.error("color pick failed", err);
    }
    handleCancel();
  }

  const selectedShape = selectedId
    ? annotations.shapes.find((s) => s.id === selectedId) ?? null
    : null;
  /** What the dropdown edits. A selected shape's own values win over the
   * session style, so opening its settings shows what that shape looks like
   * rather than what the last-drawn one did. */
  const editedStyle: Style = selectedShape
    ? { ...style, ...styleOfShape(selectedShape) }
    : style;
  /** Whose options the dropdown lists: the selected shape's, else the armed
   * tool's. Select on its own has none, which is what hides the chevron. */
  const optionsFor: ToolId | null = selectedShape
    ? toolForShape(selectedShape)
    : activeTool === "select"
      ? null
      : activeTool;

  /** Style edits go to the session (so the next shape inherits them) and, when
   * one is selected, to that shape as well. */
  function handleStyleChange(partial: Partial<Style>) {
    setStyle((s) => ({ ...s, ...partial }));
    if (selectedShape) publishShapes(annotations.update(applyStyleToShape(selectedShape, partial)));
  }

  /** Rotation belongs to one shape rather than to the session style, so it
   * writes straight through instead of going via `handleStyleChange`. */
  function rotateSelected(degrees: number) {
    if (!selectedShape || !isRotatable(selectedShape)) return;
    const rotation = ((Math.round(degrees) % 360) + 360) % 360;
    publishShapes(annotations.update({ ...selectedShape, rotation }));
  }

  function deleteSelected() {
    if (!selectedId) return;
    publishShapes(annotations.remove(selectedId));
    setSelectedId(null);
    setOpenPopover(null);
  }

  /** Hands the committed list to Rust, which fans it out to every overlay
   * window. Called on commit and undo only, never per pointermove. */
  function publishShapes(shapes: Shape[]) {
    overlaySetShapes(JSON.stringify(shapes)).catch((err) =>
      console.error("publishing overlay shapes failed", err),
    );
  }

  /** Starts (or, for the click-placed tools, completes) an annotation. */
  function beginAnnotation(p: PhysPoint, e: React.PointerEvent) {
    if (!activeTool) return;
    // Drawing replaces whatever was under edit, so the settings that open on
    // commit belong to the shape just drawn.
    setSelectedId(null);
    if (activeTool === "marker") {
      // Provisional number; the sequence is 1..n in placement order, which
      // is all the overlay offers -- there is no delete-a-marker here.
      const next = annotations.shapes.filter((s) => s.kind === "marker").length + 1;
      commitShape(createMarker(crypto.randomUUID(), p, next, style));
      return;
    }
    if (activeTool === "stamp") {
      commitShape(createStamp(crypto.randomUUID(), p, style));
      pushRecentStamp(style.stampEmoji);
      return;
    }
    if (activeTool === "text") {
      const box = containerRef.current?.getBoundingClientRect();
      setTextValue("");
      setTextEdit({ point: p, cssX: e.clientX - (box?.left ?? 0), cssY: e.clientY - (box?.top ?? 0) });
      return;
    }
    drawStartRef.current = p;
    drawingRef.current = true;
    annotations.setDraft(
      activeTool === "freehand"
        ? startFreehand("draft", p, style)
        : makeDraft(activeTool, p, p, style, e.shiftKey),
    );
  }

  function commitText() {
    const edit = textEdit;
    const value = textValue;
    setTextEdit(null);
    setTextValue("");
    if (!edit || !value.trim()) return;
    commitShape(
      createText(crypto.randomUUID(), edit.point, value, style.stroke, style.fontSize, style),
    );
  }

  /** Commits a shape, broadcasts it, and leaves it selected with its settings
   * open -- draw something, tune it, close, draw the next. */
  function commitShape(shape: Shape) {
    publishShapes(annotations.commit(shape));
    setSelectedId(shape.id);
    setOpenPopover("options");
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (pickWindow) return;
    const p = toPhys(e.clientX, e.clientY);
    if (!p) return;

    if (colorMode) {
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }

    if (measureMode) {
      (e.target as Element).setPointerCapture(e.pointerId);
      measuringRef.current = true;
      setMeasurement({ start: p, end: p });
      return;
    }

    pressPointRef.current = p;
    // While the result popover is open, the first click anywhere outside it
    // only closes it -- it used to also start drawing a new selection in
    // the same click, so results could vanish before you meant to dismiss
    // them. A second, separate click is now needed to select a new region.
    if (translateMode && translatePopover) {
      dismissTranslatePopover();
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);

    // A press that dismisses something transient does only that; a second,
    // separate press draws. Otherwise every dismissal would leave a stray
    // shape behind -- the rule the translate popover already follows.
    //
    // Text commits and then stops here for a second reason: `commitText`
    // selects the new shape and opens its settings, but this handler still
    // holds the pre-commit `openPopover`, so the dropdown guard below cannot
    // see it. Falling through would re-enter `beginAnnotation` and open a
    // second textarea instead of showing the settings for the text just typed.
    if (textEdit) {
      commitText();
      return;
    }
    if (openPopover) {
      setOpenPopover(null);
      return;
    }

    const scaleX =
      containerRef.current && monitor ? monitor.rect.w / containerRef.current.clientWidth : 1;
    const handle =
      selection && containerRef.current && monitor
        ? pickHandle(selection, p, HANDLE_HIT_CSS_PX * scaleX)
        : null;
    // Annotation is a region-mode affordance only; every other mode passes a
    // null tool, which makes `pointerIntent` reduce to today's behaviour.
    const intent = pointerIntent(p, {
      selection,
      activeTool: regionMode ? activeTool : null,
      handle,
    });

    if (intent === "resize" && handle) {
      dragModeRef.current = handle;
      dragOrigRectRef.current = selection;
      dragStartRef.current = p;
      setDragMode(handle);
      return;
    }
    if (intent === "pick-shape") {
      const hit = pickShape(annotations.shapes, p);
      setSelectedId(hit ? hit.id : null);
      shapeDragRef.current = hit ? { orig: hit, start: p } : null;
      return;
    }
    if (intent === "draw") {
      beginAnnotation(p, e);
      return;
    }
    if (intent === "move") {
      dragModeRef.current = "move";
      dragOrigRectRef.current = selection;
      dragStartRef.current = p;
      setDragMode("move");
      return;
    }

    // Outside any existing selection (or there isn't one yet) -- start
    // drawing a fresh one, replacing whatever was there. Clear the old rect
    // synchronously: `selectionBegin` is an async round trip to Rust, and
    // without this the stale selection (mask cutout, border, size label)
    // stayed rendered -- visible as a flash of the previous rectangle --
    // until that round trip resolved and updated `selection`.
    setSelection(null);
    dragModeRef.current = "draw";
    setDragMode("draw");
    selectionBegin(p);
  }

  /** Edge snapping is on in region mode unless Alt is held (the documented
   * bypass) -- and never in the other modes, which have no window-aligned
   * region to snap to. */
  function edgeSnapEnabled(e: { altKey: boolean }): boolean {
    return regionMode && !e.altKey && windows.length > 0;
  }

  /** Snaps `rect` to nearby window edges and publishes the guide lines,
   * returning the (possibly unchanged) rect for the caller to commit. */
  function applyEdgeSnap(
    rect: PhysRect,
    e: { altKey: boolean },
    moving: { left: boolean; right: boolean; top: boolean; bottom: boolean },
  ): PhysRect {
    if (!edgeSnapEnabled(e)) {
      setSnapGuides([]);
      return rect;
    }
    // Threshold in physical px, scaled so it feels like a constant ~8 CSS px
    // regardless of the monitor's scale factor.
    const scale = monitor && containerRef.current ? monitor.rect.w / containerRef.current.clientWidth : 1;
    const result = snapRectToEdges(
      rect,
      windows.map((w) => w.rect),
      Math.round(8 * scale),
      moving,
    );
    setSnapGuides(result.guides);
    return result.rect;
  }

  /** Smallest window whose bounds contain `p` -- smallest so a dialog on top
   * of its parent wins instead of the big window behind it. */
  function windowAt(p: PhysPoint): WindowInfo | null {
    return (
      [...windows]
        .filter((w) => rectContains(w.rect, p))
        .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0] ?? null
    );
  }

  function handlePointerMove(e: React.PointerEvent) {
    const p = toPhys(e.clientX, e.clientY);
    if (!p) return;

    if (containerRef.current && (colorMode || measureMode || regionMode)) {
      const box = containerRef.current.getBoundingClientRect();
      scheduleCursor({ phys: p, cssX: e.clientX - box.left, cssY: e.clientY - box.top });
    }

    if (pickWindow) {
      setHoveredWindow(windowAt(p));
      return;
    }

    if (colorMode) return;

    if (measureMode) {
      if (!measuringRef.current) return;
      // Shift locks to the dominant axis, for measuring a pure width or
      // height without hand-drifting off the line.
      setMeasurement((m) => {
        if (!m) return m;
        if (!e.shiftKey) return { ...m, end: p };
        const dx = Math.abs(p.x - m.start.x);
        const dy = Math.abs(p.y - m.start.y);
        return { ...m, end: dx >= dy ? { x: p.x, y: m.start.y } : { x: m.start.x, y: p.y } };
      });
      return;
    }

    const shapeDrag = shapeDragRef.current;
    if (shapeDrag) {
      setLiveEdit(moveShape(shapeDrag.orig, p.x - shapeDrag.start.x, p.y - shapeDrag.start.y));
      return;
    }

    if (drawingRef.current && activeTool) {
      const start = drawStartRef.current;
      if (!start) return;
      if (activeTool === "freehand") {
        annotations.setDraft((d) => (d && d.kind === "freehand" ? extendFreehand(d, p) : d));
      } else {
        annotations.setDraft(makeDraft(activeTool, start, p, style, e.shiftKey));
      }
      return;
    }

    const mode = dragModeRef.current;

    // Region mode previews window snapping only while Ctrl is held, so an
    // ordinary click can't jump the selection to a whole window by accident.
    // Suppressed inside an existing selection, where a press means "move it"
    // and no snap would happen anyway -- highlighting there would promise
    // something the click doesn't do.
    if (!mode && regionMode) {
      const canSnap = e.ctrlKey && !(selection && rectContains(selection, p));
      setHoveredWindow(canSnap ? windowAt(p) : null);
    }
    if (mode === "draw") {
      const anchor = pressPointRef.current;
      // The plain path stays server-side (`selectionUpdate` derives the rect
      // from the anchor Rust holds); aspect/snap need the rect client-side to
      // adjust it, so those go through `selectionSetRect` instead.
      if (!anchor || (aspect === null && !edgeSnapEnabled(e))) {
        setSnapGuides([]);
        selectionUpdate(p);
        return;
      }
      const raw = constrainToAspect(rectFromPoints(anchor, p), aspect, anchor);
      const growsRight = p.x >= anchor.x;
      const growsDown = p.y >= anchor.y;
      selectionSetRect(
        applyEdgeSnap(raw, e, {
          left: !growsRight,
          right: growsRight,
          top: !growsDown,
          bottom: growsDown,
        }),
      );
      return;
    }
    if (mode === "move") {
      const orig = dragOrigRectRef.current;
      const start = dragStartRef.current;
      if (!orig || !start) return;
      const moved = {
        x: orig.x + (p.x - start.x),
        y: orig.y + (p.y - start.y),
        w: orig.w,
        h: orig.h,
      };
      // A body drag translates the rect, so snapping one edge has to carry
      // the opposite edge with it rather than resizing.
      const snapped = applyEdgeSnap(moved, e, { left: true, right: true, top: true, bottom: true });
      selectionSetRect({ x: snapped.x, y: snapped.y, w: moved.w, h: moved.h });
      return;
    }
    if (mode) {
      const orig = dragOrigRectRef.current;
      if (!orig) return;
      const resized = resizeRect(orig, mode, p);
      const anchor = {
        x: mode.includes("w") ? orig.x + orig.w : orig.x,
        y: mode.includes("n") ? orig.y + orig.h : orig.y,
      };
      const shaped = constrainToAspect(resized, aspect, anchor);
      selectionSetRect(
        applyEdgeSnap(shaped, e, {
          left: mode.includes("w"),
          right: mode.includes("e"),
          top: mode.includes("n"),
          bottom: mode.includes("s"),
        }),
      );
    }
  }

  async function handlePointerUp(e: React.PointerEvent) {
    if (pickWindow) {
      if (hoveredWindow) {
        selectionConfirmWindow(hoveredWindow.rect);
      }
      return;
    }

    if (colorMode) {
      const p = toPhys(e.clientX, e.clientY);
      if (p) await pickColorAt(p);
      return;
    }

    if (measureMode) {
      measuringRef.current = false;
      return;
    }

    const shapeDrag = shapeDragRef.current;
    if (shapeDrag) {
      shapeDragRef.current = null;
      const moved = liveEdit;
      setLiveEdit(null);
      // One undo step for the whole drag, not one per pointermove.
      if (moved) publishShapes(annotations.update(moved));
      // A click rather than a drag means "show me this shape's settings".
      else setOpenPopover("options");
      return;
    }

    if (drawingRef.current) {
      drawingRef.current = false;
      const start = drawStartRef.current;
      drawStartRef.current = null;
      const draft = annotations.draft;
      const p = toPhys(e.clientX, e.clientY);
      // A click rather than a drag would otherwise commit a zero-size shape,
      // invisible but real -- the same slop the window-snap click uses.
      const travelled =
        p && start ? Math.hypot(p.x - start.x, p.y - start.y) : Number.POSITIVE_INFINITY;
      if (draft && travelled >= CLICK_SLOP_PX) {
        commitShape({ ...draft, id: crypto.randomUUID() });
      } else {
        annotations.setDraft(null);
      }
      return;
    }

    const mode = dragModeRef.current;

    // Ctrl+click (rather than a drag) on a window in region mode snaps the
    // selection to that window's bounds, still editable and confirmable.
    if (regionMode && mode === "draw" && e.ctrlKey) {
      const p = toPhys(e.clientX, e.clientY);
      const press = pressPointRef.current;
      const travelled =
        p && press ? Math.hypot(p.x - press.x, p.y - press.y) : Number.POSITIVE_INFINITY;
      if (p && travelled < CLICK_SLOP_PX) {
        const hit = windowAt(p);
        if (hit) {
          dragModeRef.current = null;
          dragOrigRectRef.current = null;
          dragStartRef.current = null;
          setDragMode(null);
          setHoveredWindow(null);
          pressPointRef.current = null;
          await selectionSetRect(hit.rect);
          return;
        }
      }
    }
    pressPointRef.current = null;
    // The final rect, computed without waiting on the `selection:changed`
    // broadcast -- that listener can still be a frame behind the last
    // pointermove, which matters here because translation mode acts on
    // this value immediately. "draw" has no rect available client-side
    // (the anchor point lives only in Rust `SelectionState`), so that one
    // case does await the command's own return value instead.
    let finalRect: PhysRect | null = selection;
    const p = toPhys(e.clientX, e.clientY);
    if (mode === "draw") {
      finalRect = p ? await selectionEnd(p) : null;
    } else if (mode === "move") {
      const orig = dragOrigRectRef.current;
      const start = dragStartRef.current;
      if (orig && start && p) {
        finalRect = { x: orig.x + (p.x - start.x), y: orig.y + (p.y - start.y), w: orig.w, h: orig.h };
      }
    } else if (mode) {
      const orig = dragOrigRectRef.current;
      if (orig && p) finalRect = resizeRect(orig, mode, p);
    }

    dragModeRef.current = null;
    dragOrigRectRef.current = null;
    dragStartRef.current = null;
    setDragMode(null);
    // Guides are a live drag affordance; leaving them up afterwards reads
    // as a permanent part of the selection.
    setSnapGuides([]);

    if (translateMode && finalRect) {
      runTranslate(finalRect);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Escape steps back out one layer at a time: the colour picker first
        // (it opens inside the settings dropdown), then the dropdown, then
        // the selection, then the tool, and only then the capture.
        if (openPopover === "color") {
          setOpenPopover("options");
          return;
        }
        if (openPopover) {
          setOpenPopover(null);
          return;
        }
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        // Escape disarms an annotation tool first: with one armed it is far
        // likelier to mean "stop drawing" than "throw the capture away",
        // and a second press still cancels.
        if (regionMode && activeTool) {
          setActiveTool(null);
          return;
        }
        handleCancel();
        return;
      }
      if (regionMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const next = e.shiftKey
          ? annotationsRef.current.redo()
          : annotationsRef.current.undo();
        publishShapes(next);
        // The shape under edit may have just been undone out of existence.
        setSelectedId(null);
        return;
      }
      if (regionMode && (e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (colorMode && e.key.toLowerCase() === "f") {
        setColorFormat((f) => COLOR_FORMATS[(COLOR_FORMATS.indexOf(f) + 1) % COLOR_FORMATS.length]);
        return;
      }
      if (measureMode) {
        if (e.key === "Enter" && measurement) copyMeasurement(measurement);
        return;
      }
      if (e.key === "Enter" && !pickWindow && !translateMode) {
        handleConfirm();
      }
    }
    // Letting go of Ctrl without moving the pointer has to drop the snap
    // preview too -- otherwise the highlight sits there implying a click
    // would still snap, which it no longer would.
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "Control" && regionMode) setHoveredWindow(null);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pickWindow, translateMode, colorMode, measureMode, measurement, regionMode, activeTool, openPopover, selectedId]);

  const monitorOrigin: PhysPoint = monitor
    ? { x: monitor.rect.x, y: monitor.rect.y }
    : { x: 0, y: 0 };
  const cursorColor: Rgb | null =
    cursor && imgLoaded ? samplePixel(frameCanvasRef.current, cursor.phys, monitorOrigin) : null;

  async function copyMeasurement(m: Measurement) {
    try {
      await copyTextToClipboard(measurementLabel(m.start, m.end));
    } catch (err) {
      console.error("copying measurement failed", err);
    }
  }

  const localSelection = monitor && selection ? rectIntersect(selection, monitor.rect) : null;

  // Selection rect expressed relative to this monitor, in percent -- used to
  // carve four mask bars (top/bottom/left/right) around it so the selected
  // area itself stays unmasked instead of drawing a translucent rect over it.
  const sel =
    localSelection && monitor
      ? {
          left: (localSelection.x - monitor.rect.x) / monitor.rect.w,
          top: (localSelection.y - monitor.rect.y) / monitor.rect.h,
          right: (localSelection.x - monitor.rect.x + localSelection.w) / monitor.rect.w,
          bottom: (localSelection.y - monitor.rect.y + localSelection.h) / monitor.rect.h,
        }
      : null;

  // Once a selection exists and the user isn't actively drawing a brand new
  // one, it becomes editable in place: draggable body (move), 8 resize
  // handles, and a confirm/cancel pair -- so a mis-drawn region doesn't
  // require starting over, and confirming doesn't require the keyboard.
  const editable = sel !== null && dragMode !== "draw";

  // Virtual-screen coordinate -> fraction of this monitor's width/height,
  // the same normalization `sel` does, for chrome positioned by absolute
  // physical coordinate (the snap guides) rather than by the selection.
  const physToFracX = (x: number) => (monitor ? (x - monitor.rect.x) / monitor.rect.w : 0);
  const physToFracY = (y: number) => (monitor ? (y - monitor.rect.y) / monitor.rect.h : 0);

  // Horizontal center for the translate-mode result popover, clamped in CSS
  // pixels so its fixed 320px width (`w-80`) can't run off the left/right
  // edge of the monitor -- `sel`'s other positions are percent-based and
  // fine to center-anchor freely, but a fixed-width box centered on a
  // selection near either edge got cut off before this clamp existed.
  // Cancel, pin, copy, save, edit, confirm: six 36px buttons with 8px gaps.
  const ACTION_BUTTONS_W = 6 * 36 + 5 * 8;
  const ACTION_BUTTONS_H = 36;
  // Select plus the configured tools (32px each), the settings chevron (24px,
  // whose slot is always reserved), the separator, and undo/redo, plus the
  // bar's own padding. Constant for a given tool set, so arming a tool cannot
  // move the bar. Only used to keep it on screen, so an approximation within a
  // few pixels is fine -- it just has to track the real content.
  const quickToolsWidth = (overlayTools.length + 1) * 32 + 24 + 90;
  const showQuickTools = regionMode && editable && sel !== null && overlayTools.length > 0;
  /** The quick-tools bar, preferring above the selection. Placed first so the
   * action cluster can step around it. */
  const quickTools =
    sel && containerRef.current
      ? placeCluster(
          sel,
          { w: containerRef.current.clientWidth, h: containerRef.current.clientHeight },
          { w: quickToolsWidth, h: ACTION_BUTTONS_H },
          "above",
        )
      : { left: 0, top: 0 };

  /** Where the confirm/pin/cancel cluster sits, in CSS pixels, kept fully on
   * this monitor -- preferring below the selection, and stacking clear of the
   * tool bar when a selection hugging an edge forces both onto the same side. */
  const actionButtons =
    sel && containerRef.current
      ? placeCluster(
          sel,
          { w: containerRef.current.clientWidth, h: containerRef.current.clientHeight },
          { w: ACTION_BUTTONS_W, h: ACTION_BUTTONS_H },
          "below",
          showQuickTools ? { top: quickTools.top, height: ACTION_BUTTONS_H } : null,
        )
      : { left: 0, top: 0 };

  const TRANSLATE_POPOVER_W = 320;
  const TRANSLATE_POPOVER_MARGIN = 8;
  const translatePopoverCenterX = (() => {
    if (!sel || !containerRef.current) return 0;
    const containerWidth = containerRef.current.clientWidth;
    const rawCenterX = ((sel.left + sel.right) / 2) * containerWidth;
    const half = TRANSLATE_POPOVER_W / 2;
    return Math.min(
      Math.max(rawCenterX, TRANSLATE_POPOVER_MARGIN + half),
      Math.max(containerWidth - TRANSLATE_POPOVER_MARGIN - half, TRANSLATE_POPOVER_MARGIN + half),
    );
  })();

  // Every way a selection lifecycle ends clears the rect synchronously
  // instead of waiting on the next `overlay:frame` reset (or a
  // `selection:changed` broadcast) -- the overlay window can stay visible
  // for a moment after confirm/cancel/pin while it's being hidden, and
  // without this the last-drawn rect (mask cutout, border, size label)
  // stayed on screen during that gap, visible as a flash of the previous
  // selection the next time an overlay opens.
  /** Commits typed width/height, re-anchored at the selection's top-left so
   * the rect grows right/down from where it already is. */
  function commitDimensions() {
    const draft = dimDraft;
    setDimDraft(null);
    if (!draft || !selection) return;
    const w = Math.max(1, Math.round(Number(draft.w)));
    const h = Math.max(1, Math.round(Number(draft.h)));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    if (w === selection.w && h === selection.h) return;
    // With an aspect locked, the typed width wins and the height follows --
    // committing both verbatim would silently break the lock.
    const ratio = aspectRatio(aspect);
    const height = ratio === null ? h : Math.max(1, Math.round(w / ratio));
    selectionSetRect({ x: selection.x, y: selection.y, w, h: height });
  }

  function changeAspect(next: AspectId) {
    setAspect(next);
    if (next === null) localStorage.removeItem(ASPECT_STORAGE_KEY);
    else localStorage.setItem(ASPECT_STORAGE_KEY, next);
    // Reshape what's already selected so the lock takes effect immediately
    // rather than only on the next drag.
    if (selection && next !== null) {
      selectionSetRect(constrainToAspect(selection, next, { x: selection.x, y: selection.y }));
    }
  }

  /** Flattens the confirmed region and its annotations to PNG. The base
   * pixels come from Rust rather than this window's frame canvas: a selection
   * can span monitors, and each overlay window holds only its own monitor. */
  async function flattenSelection(rect: PhysRect): Promise<Uint8Array> {
    const imageId = await selectionRegionImage();
    try {
      const bitmap = await fetchShotImage(imageId);
      const base = document.createElement("canvas");
      base.width = bitmap.width;
      base.height = bitmap.height;
      base.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      // Image space, whose origin is the selection's top-left -- the single
      // conversion point between the overlay and everything downstream.
      return await flattenToPng(base, rebaseToRegion(annotations.shapes, rect));
    } finally {
      releaseImage(imageId).catch(() => {});
    }
  }

  /** Confirms the capture, baking in any annotations. With none drawn this is
   * byte-for-byte the original path: Rust composites from the frozen session
   * and nothing round-trips through the webview. */
  async function handleConfirm(dest: ConfirmDest = "default") {
    const rect = selection;
    setSelection(null);
    try {
      if (dest !== "default") await selectionSetDest(dest);
      const route = confirmRoute(dest, postCapture, annotations.shapes.length > 0 && !!rect);
      if (route === "plain") {
        await selectionConfirm();
      } else if (route === "editor") {
        await selectionConfirmToEditor(shapesForEditor(rect));
      } else {
        await selectionConfirmAnnotated(await flattenSelection(rect!));
      }
    } catch (err) {
      console.error("confirming the capture failed", err);
    }
  }

  /** The annotations in image space, as the editor's `PendingEditorShapes`
   * expects them. Empty string means "no annotations". */
  function shapesForEditor(rect: PhysRect | null): string {
    if (!rect || annotations.shapes.length === 0) return "";
    return JSON.stringify(rebaseToRegion(annotations.shapes, rect));
  }

  /** Always the editor, whatever `post_capture` says -- and the annotations
   * travel as shapes, so they arrive editable rather than baked in. */
  async function handleEdit() {
    const rect = selection;
    setSelection(null);
    try {
      await selectionConfirmToEditor(shapesForEditor(rect));
    } catch (err) {
      console.error("opening the editor failed", err);
    }
  }
  function handlePin() {
    setSelection(null);
    selectionConfirmPin();
  }
  function handleCancel() {
    setSelection(null);
    selectionCancel();
  }

  return (
    <div
      ref={containerRef}
      className="relative w-screen h-screen overflow-hidden cursor-crosshair select-none"
      style={{ background: "var(--fg)" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => scheduleCursor(null)}
      onDoubleClick={() =>
        !pickWindow && !translateMode && !colorMode && !measureMode && handleConfirm()
      }
    >
      <canvas
        ref={frameCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ imageRendering: "pixelated", visibility: imgLoaded ? "visible" : "hidden" }}
      />

      {/* Above the frozen frame, below the mask and every piece of chrome:
       * annotations are part of the picture, not part of the UI. */}
      <canvas
        ref={annotationCanvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {imgLoaded && (
        <div className="absolute inset-0 pointer-events-none">
          {sel ? (
            <>
              <div
                className="absolute"
                style={{ left: 0, top: 0, right: 0, height: pct(sel.top, 1), background: "var(--overlay-mask)" }}
              />
              <div
                className="absolute"
                style={{ left: 0, bottom: 0, right: 0, top: pct(sel.bottom, 1), background: "var(--overlay-mask)" }}
              />
              <div
                className="absolute"
                style={{ left: 0, top: pct(sel.top, 1), width: pct(sel.left, 1), height: pct(sel.bottom - sel.top, 1), background: "var(--overlay-mask)" }}
              />
              <div
                className="absolute"
                style={{ right: 0, top: pct(sel.top, 1), width: pct(1 - sel.right, 1), height: pct(sel.bottom - sel.top, 1), background: "var(--overlay-mask)" }}
              />
              <div
                className="absolute border border-[var(--accent)]"
                style={{
                  left: pct(sel.left, 1),
                  top: pct(sel.top, 1),
                  width: pct(sel.right - sel.left, 1),
                  height: pct(sel.bottom - sel.top, 1),
                  pointerEvents: editable ? "auto" : "none",
                  // With a tool armed a press inside draws rather than moves,
                  // so the move cursor would promise the wrong gesture.
                  cursor: editable && !activeTool ? "move" : "crosshair",
                }}
              />
              <span
                className="absolute flex items-center gap-1 text-[11px] font-mono bg-[var(--fg)] text-[var(--bg)] px-1.5 py-0.5 rounded-[3px]"
                style={{
                  left: pct(sel.left, 1),
                  top: `calc(${pct(sel.top, 1)} - 22px)`,
                  pointerEvents: editable ? "auto" : "none",
                }}
                // The label sits inside the container's pointer handlers; a
                // press on the inputs would otherwise start a fresh drag
                // underneath and immediately blur the field being typed in.
                onPointerDown={(e) => e.stopPropagation()}
              >
                {editable ? (
                  <>
                    <input
                      aria-label="Selection width"
                      className="w-10 bg-transparent text-right outline-none focus:underline"
                      value={dimDraft ? dimDraft.w : String(selection?.w ?? 0)}
                      onChange={(e) => setDimDraft({ w: e.target.value, h: dimDraft?.h ?? String(selection?.h ?? 0) })}
                      onBlur={commitDimensions}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitDimensions();
                        if (e.key === "Escape") setDimDraft(null);
                        e.stopPropagation();
                      }}
                    />
                    ×
                    <input
                      aria-label="Selection height"
                      className="w-10 bg-transparent outline-none focus:underline"
                      value={dimDraft ? dimDraft.h : String(selection?.h ?? 0)}
                      onChange={(e) => setDimDraft({ w: dimDraft?.w ?? String(selection?.w ?? 0), h: e.target.value })}
                      onBlur={commitDimensions}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitDimensions();
                        if (e.key === "Escape") setDimDraft(null);
                        e.stopPropagation();
                      }}
                    />
                  </>
                ) : (
                  <>
                    {selection?.w} × {selection?.h}
                  </>
                )}
              </span>
              {editable &&
                HANDLES.map(({ id, xFrac, yFrac, cursor }) => (
                  <div
                    key={id}
                    // Sharp corners (no rounding) to match the square resize
                    // handles the editor's crop/select tools draw on canvas
                    // (`Canvas.tsx`'s `drawHandlesAt`, plain `ctx.rect`) --
                    // this and the editor previously used different corner
                    // treatments for the same interaction.
                    className="absolute w-3 h-3 bg-white border-2 border-[var(--accent)] shadow-[var(--shadow-sm)]"
                    style={{
                      left: pct(sel.left + (sel.right - sel.left) * xFrac, 1),
                      top: pct(sel.top + (sel.bottom - sel.top) * yFrac, 1),
                      transform: "translate(-50%, -50%)",
                      cursor,
                      pointerEvents: "auto",
                    }}
                  />
                ))}
            </>
          ) : (
            // Color and measure modes read the screen rather than carve a
            // region out of it, so they show the frame undimmed.
            !colorMode &&
            !measureMode && <div className="absolute inset-0" style={{ background: "var(--overlay-mask)" }} />
          )}

          {(pickWindow || regionMode) && hoveredWindow && monitor && (
            <div
              className="absolute border-2 border-[var(--accent)]"
              style={{
                // Fainter in region mode: there it's a hint that clicking
                // would snap to this window, not the primary interaction.
                background: pickWindow
                  ? "color-mix(in srgb, var(--accent) 15%, transparent)"
                  : "color-mix(in srgb, var(--accent) 8%, transparent)",
                left: pct(hoveredWindow.rect.x - monitor.rect.x, monitor.rect.w),
                top: pct(hoveredWindow.rect.y - monitor.rect.y, monitor.rect.h),
                width: pct(hoveredWindow.rect.w, monitor.rect.w),
                height: pct(hoveredWindow.rect.h, monitor.rect.h),
              }}
            />
          )}
        </div>
      )}

      {editable && sel && !translateMode && (
        <div
          className="absolute flex items-center gap-2 cursor-default"
          // Stops the pointerdown from bubbling to the container's handler,
          // which hit-tests against the selection rect to decide whether to
          // move/resize/start-a-new-draw -- these buttons sit just outside
          // that rect by design, so without this every click here read as
          // "outside the selection" and started a fresh 1x1 draw before the
          // button's own onClick ever got a chance to run.
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            left: actionButtons.left,
            top: actionButtons.top,
            transform: "translateX(-50%)",
          }}
        >
          {/* Shared `IconButton` (same rounded-square shape used by the
           * editor's crop confirm/cancel and everywhere else in the app)
           * instead of one-off `rounded-full` buttons -- this cluster used
           * to be the only place in the app rendering circular buttons,
           * which read as a different control than the visually-identical
           * "confirm/cancel a rectangular selection" pair in the editor's
           * crop tool. */}
          <IconButton
            label="Cancel"
            icon={<X size={18} />}
            variant="secondary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handleCancel()}
          />
          <IconButton
            label="Pin to screen"
            icon={<PinIcon size={16} />}
            variant="secondary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handlePin()}
          />
          <IconButton
            label="Copy to clipboard"
            icon={<Copy size={16} />}
            variant="secondary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handleConfirm("copy")}
          />
          <IconButton
            label="Save to file"
            icon={<Download size={16} />}
            variant="secondary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handleConfirm("save")}
          />
          {/* Distinct from Confirm on purpose: Confirm runs whatever
            * post-capture action is configured, which may not be the editor
            * at all. */}
          <IconButton
            label="Open in editor"
            icon={<Pencil size={16} />}
            variant="secondary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handleEdit()}
          />
          <IconButton
            label="Confirm capture"
            icon={<Check size={18} />}
            variant="primary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handleConfirm()}
          />
        </div>
      )}

      {showQuickTools && (
        <QuickTools
          tools={[SELECT_TOOL, ...overlayTools]}
          activeTool={activeTool}
          onSelectTool={(tool) => {
            setActiveTool(tool);
            // The settings belonged to whatever was under edit; arming a
            // different tool ends that.
            setSelectedId(null);
            setOpenPopover(null);
          }}
          style={editedStyle}
          onStyleChange={handleStyleChange}
          optionsFor={optionsFor}
          selectedShape={selectedShape}
          onRotate={rotateSelected}
          onDeleteSelected={selectedShape ? deleteSelected : null}
          canUndo={annotations.canUndo}
          onUndo={() => publishShapes(annotations.undo())}
          canRedo={annotations.canRedo}
          onRedo={() => publishShapes(annotations.redo())}
          openPopover={openPopover}
          onOpenPopover={setOpenPopover}
          left={quickTools.left}
          top={quickTools.top}
        />
      )}

      {textEdit && monitor && containerRef.current && (
        <textarea
          ref={textareaRef}
          rows={Math.max(1, textValue.split("\n").length)}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Stopped from reaching the window handler, where Escape would
            // cancel the whole capture and Enter would confirm it mid-word.
            e.stopPropagation();
            if (e.key === "Escape") {
              setTextEdit(null);
              setTextValue("");
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              commitText();
            }
          }}
          className="absolute bg-transparent border border-dashed border-[var(--accent)] outline-none resize-none p-0.5"
          style={{
            left: textEdit.cssX,
            top: textEdit.cssY,
            // Font size is in physical pixels like the shape it becomes, so
            // it has to come back down to CSS pixels to preview at scale.
            fontSize: style.fontSize * (containerRef.current.clientWidth / monitor.rect.w),
            color: style.stroke,
            minWidth: 120,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
          }}
        />
      )}

      {translateMode && sel && translatePopover && (
        <div
          className="absolute z-50 w-80 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] flex flex-col overflow-hidden cursor-default"
          // Stops pointerdown from starting a fresh drag on the container
          // (same reasoning as the confirm/cancel button block below) --
          // AND pointerup, which pointerdown alone doesn't cover: without
          // it, any click inside this popover (including the tab buttons)
          // still bubbled up to the container's pointerup handler, which
          // re-ran translation on the unchanged selection rect and reset
          // the popover before the tab switch ever became visible.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          style={{
            left: translatePopoverCenterX,
            top: sel.bottom > 0.75 ? pct(sel.top, 1) : pct(sel.bottom, 1),
            transform: sel.bottom > 0.75 ? "translate(-50%, calc(-100% - 10px))" : "translate(-50%, 10px)",
          }}
        >
          <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
            <span className="text-xs font-medium text-[var(--fg-muted)]">Extracted text</span>
            <button
              aria-label="Close"
              onClick={() => dismissTranslatePopover()}
              className="inline-flex items-center justify-center w-8 h-8 -m-1.5 -mr-1.5 rounded-[var(--radius-sm)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--focus-ring)]"
            >
              <X size={14} />
            </button>
          </div>
          <div className="p-3 flex flex-col gap-3">
            {translatePopover.loading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)] py-2">
                <Loader2 size={14} className="animate-spin" /> Reading & translating…
              </div>
            ) : translatePopover.error ? (
              <p className="text-sm text-[var(--danger)]">{translatePopover.error}</p>
            ) : (
              <ResultTabs
                tab={resultTab}
                onTabChange={setResultTab}
                origin={translatePopover.origin}
                enabled={translateEnabled}
                translated={translatePopover.translated}
                translating={false}
                translateError={null}
                truncated={translatePopover.truncated}
                originLang={translatePopover.detectedLang ?? translateTarget}
                translateLang={translateTarget}
                downloadingLang={downloadingLang}
                missingLang={
                  translatePopover.detectedLang &&
                  ISO_TO_OCR_LANG[translatePopover.detectedLang] &&
                  !installedLangs.includes(ISO_TO_OCR_LANG[translatePopover.detectedLang].code)
                    ? {
                        isoCode: translatePopover.detectedLang,
                        label: ISO_TO_OCR_LANG[translatePopover.detectedLang].label,
                      }
                    : null
                }
                onDownloadLang={handleDownloadLang}
              />
            )}
          </div>
        </div>
      )}

      {measureMode && measurement && monitor && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${monitor.rect.w} ${monitor.rect.h}`} preserveAspectRatio="none">
          <line
            x1={measurement.start.x - monitor.rect.x}
            y1={measurement.start.y - monitor.rect.y}
            x2={measurement.end.x - monitor.rect.x}
            y2={measurement.end.y - monitor.rect.y}
            stroke="var(--accent)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          {[measurement.start, measurement.end].map((p, i) => (
            <circle
              key={i}
              cx={p.x - monitor.rect.x}
              cy={p.y - monitor.rect.y}
              r={4}
              fill="#fff"
              stroke="var(--accent)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}

      {measureMode && measurement && monitor && (
        <div
          className="absolute z-40 flex items-center gap-2 px-2.5 h-8 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-md)] text-xs font-mono text-[var(--fg)]"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          style={{
            left: pct((measurement.start.x + measurement.end.x) / 2 - monitor.rect.x, monitor.rect.w),
            top: `calc(${pct(Math.min(measurement.start.y, measurement.end.y) - monitor.rect.y, monitor.rect.h)} - 40px)`,
            transform: "translateX(-50%)",
          }}
        >
          {measurementLabel(measurement.start, measurement.end)}
          <button
            type="button"
            onClick={() => copyMeasurement(measurement)}
            className="text-[var(--accent)] hover:underline"
          >
            Copy
          </button>
        </div>
      )}

      {imgLoaded && cursor && (colorMode || measureMode || (regionMode && !selection) || dragMode === "draw") && containerRef.current && (
        <Loupe
          frameCanvas={frameCanvasRef.current}
          point={cursor.phys}
          monitorOrigin={monitorOrigin}
          cssX={cursor.cssX}
          cssY={cursor.cssY}
          containerWidth={containerRef.current.clientWidth}
          containerHeight={containerRef.current.clientHeight}
          color={cursorColor}
          format={colorFormat}
          caption={measureMode && measurement ? measurementLabel(measurement.start, measurement.end) : undefined}
        />
      )}

      {(translateMode || colorMode || measureMode) && (
        <button
          type="button"
          onClick={() => handleCancel()}
          className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-[var(--surface)] text-[var(--fg)] border border-[var(--border)] shadow-[var(--shadow-md)] hover:bg-[var(--surface-hover)] text-sm font-medium"
        >
          <X size={14} /> Exit
        </button>
      )}

      {imgLoaded &&
        snapGuides.map((g) => (
          <div
            key={`${g.axis}-${g.position}`}
            className="absolute bg-[var(--accent)] pointer-events-none"
            style={
              g.axis === "x"
                ? { left: pct(physToFracX(g.position), 1), top: 0, bottom: 0, width: 1 }
                : { top: pct(physToFracY(g.position), 1), left: 0, right: 0, height: 1 }
            }
          />
        ))}

      {imgLoaded && regionMode && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-0.5 p-1 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-md)]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {ASPECT_OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => changeAspect(o.id)}
              className={`h-7 px-2.5 rounded-full text-[11px] font-medium ${
                aspect === o.id
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {imageId && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-[var(--bg)] bg-[var(--fg)]/80 px-3 py-1.5 rounded-full pointer-events-none">
          {pickWindow
            ? "Click a window to capture it · Esc to cancel"
            : colorMode
              ? `Click to copy color · F for format (${colorFormat.toUpperCase()}) · Esc to cancel`
              : measureMode
                ? "Drag to measure · Shift locks the axis · Enter to copy · Esc to exit"
                : translateMode
                  ? translateEnabled
                    ? "Drag to select a region to translate · Esc to exit"
                    : "Drag to select a region to extract text · Esc to exit"
                  : editable
                    ? "Drag to move · Alt disables edge snap · Enter to capture · Esc to cancel"
                    : "Drag to select · Ctrl+click a window to snap · Alt disables edge snap · Enter to capture · Esc to cancel"}
        </div>
      )}
    </div>
  );
}
