import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Check, X, Loader2, Pin as PinIcon } from "lucide-react";
import {
  listMonitors,
  listWindows,
  onSelectionChanged,
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
import { rectContains, rectIntersect, type PhysPoint, type PhysRect } from "../lib/geometry";
import { measurementLabel } from "../lib/color";
import { ResultTabs, type ResultTab } from "../ui/ResultTabs";
import { IconButton } from "../ui/IconButton";
import { HANDLES, pickHandle, resizeRect, type HandleId } from "./resize";
import {
  COLOR_FORMATS,
  Loupe,
  formatColor,
  samplePixel,
  type ColorFormat,
  type Rgb,
} from "./Loupe";

interface OverlayProps {
  params: URLSearchParams;
}

interface OverlayFrame {
  image_id: string;
  mode: "region" | "window" | "translate" | "color" | "measure";
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

function pct(numerator: number, denominator: number): string {
  return `${(numerator / denominator) * 100}%`;
}

export function Overlay({ params }: OverlayProps) {
  const monitorId = Number(params.get("monitor"));

  const containerRef = useRef<HTMLDivElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
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
        setFrame(e.payload);
        // Region mode loads them too: hovering a window there highlights it
        // and a click (rather than a drag) snaps the selection to its bounds.
        if (e.payload.mode === "window" || e.payload.mode === "region") {
          listWindows().then(setWindows);
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

  // Runs on the commit that first renders the mask/hint UI over the drawn
  // frame -- only now is it safe for Rust to show this window (showing any
  // earlier flashed a blank fullscreen window while the frame loaded).
  useEffect(() => {
    if (imgLoaded && imageId) overlayReady(monitorId);
  }, [imgLoaded, imageId, monitorId]);

  useEffect(() => {
    const unlisten = onSelectionChanged((e) => setSelection(e.rect));
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

    if (selection && containerRef.current && monitor) {
      const sx = monitor.rect.w / containerRef.current.clientWidth;
      const handle = pickHandle(selection, p, HANDLE_HIT_CSS_PX * sx);
      if (handle) {
        dragModeRef.current = handle;
        dragOrigRectRef.current = selection;
        dragStartRef.current = p;
        setDragMode(handle);
        return;
      }
      if (rectContains(selection, p)) {
        dragModeRef.current = "move";
        dragOrigRectRef.current = selection;
        dragStartRef.current = p;
        setDragMode("move");
        return;
      }
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
      selectionUpdate(p);
      return;
    }
    if (mode === "move") {
      const orig = dragOrigRectRef.current;
      const start = dragStartRef.current;
      if (!orig || !start) return;
      selectionSetRect({
        x: orig.x + (p.x - start.x),
        y: orig.y + (p.y - start.y),
        w: orig.w,
        h: orig.h,
      });
      return;
    }
    if (mode) {
      const orig = dragOrigRectRef.current;
      if (!orig) return;
      selectionSetRect(resizeRect(orig, mode, p));
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

    if (translateMode && finalRect) {
      runTranslate(finalRect);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleCancel();
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
  }, [pickWindow, translateMode, colorMode, measureMode, measurement, regionMode]);

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

  // Horizontal center for the translate-mode result popover, clamped in CSS
  // pixels so its fixed 320px width (`w-80`) can't run off the left/right
  // edge of the monitor -- `sel`'s other positions are percent-based and
  // fine to center-anchor freely, but a fixed-width box centered on a
  // selection near either edge got cut off before this clamp existed.
  // Cancel + pin + confirm: three 36px circles with two 8px gaps.
  const ACTION_BUTTONS_W = 3 * 36 + 2 * 8;
  const ACTION_BUTTONS_H = 36;
  const ACTION_MARGIN = 8;
  /** Where the confirm/pin/cancel cluster sits, in CSS pixels, kept fully on
   * this monitor. Preference order: just below the selection, else just above
   * it, else pinned inside the bottom edge -- a selection spanning the full
   * height (or sitting hard against an edge) has no room outside it at all,
   * and previously the group was simply centered on the selection and could
   * hang off any side. */
  const actionButtons = (() => {
    if (!sel || !containerRef.current) return { left: 0, top: 0 };
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    const half = ACTION_BUTTONS_W / 2;
    const minLeft = ACTION_MARGIN + half;
    const left = Math.min(
      Math.max(((sel.left + sel.right) / 2) * cw, minLeft),
      Math.max(cw - ACTION_MARGIN - half, minLeft),
    );
    const below = sel.bottom * ch + 10;
    const above = sel.top * ch - ACTION_BUTTONS_H - 10;
    const top =
      below + ACTION_BUTTONS_H + ACTION_MARGIN <= ch
        ? below
        : above >= ACTION_MARGIN
          ? above
          : Math.max(ACTION_MARGIN, ch - ACTION_BUTTONS_H - ACTION_MARGIN);
    return { left, top };
  })();

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
  function handleConfirm() {
    setSelection(null);
    selectionConfirm();
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
                  cursor: editable ? "move" : undefined,
                }}
              />
              <span
                className="absolute text-[11px] font-mono bg-[var(--fg)] text-[var(--bg)] px-1.5 py-0.5 rounded-[3px]"
                style={{ left: pct(sel.left, 1), top: `calc(${pct(sel.top, 1)} - 22px)` }}
              >
                {selection?.w} × {selection?.h}
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
            label="Confirm capture"
            icon={<Check size={18} />}
            variant="primary"
            size="md"
            className="shadow-[var(--shadow-md)]"
            onClick={() => handleConfirm()}
          />
        </div>
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
                    ? "Drag to move · Enter to capture · Esc to cancel"
                    : "Drag to select · Ctrl+click a window to snap · Enter to capture · Esc to cancel"}
        </div>
      )}
    </div>
  );
}
