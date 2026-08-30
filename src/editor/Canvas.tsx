import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { useEditorStore } from "./store";
import { render } from "./render";
import {
  clampHandles,
  handlesFor,
  rectHandles,
  rotatedBounds,
  rotationCenter,
  rotationOf,
  shapeBounds,
  type HandleId,
  type ImgPoint,
  type MeasureLine,
  type RectHandleId,
  type Shape,
} from "./types";
import { measurementLabel, type Rgb } from "../lib/color";
import { createRect } from "./tools/rect";
import { createEllipse } from "./tools/ellipse";
import { createArrow } from "./tools/arrow";
import { startFreehand, extendFreehand } from "./tools/freehand";
import { clusterWordsToLines, createHighlight, snapHighlightToLines } from "./tools/highlight";
import { createPixelate } from "./tools/pixelate";
import { createMarker } from "./tools/marker";
import { createStamp, pushRecentStamp } from "./tools/stamp";
import { createLoupe } from "./tools/loupe";
import { snapShapeDrag, type AlignGuide } from "./tools/snap";
import { applyAdjustments, isIdentity } from "./tools/adjust";
import { createText } from "./tools/text";
import { pickShape, pickHandle, cloneShape, moveShape, resizeShape } from "./tools/select";
import { createSpotlight } from "./tools/spotlight";
import { createCropRect, moveCropRect, resizeCropRect } from "./tools/crop";
import { presetCss } from "./tools/backdrop";
import type { PhysRect } from "../lib/geometry";
import type { OcrWordBox } from "../lib/ipc";
import { IconButton } from "../ui/IconButton";

interface CanvasProps {
  baseImage: ImageBitmap;
  /** Cursor position each pointermove: image point, viewport coords for
   * positioning followers, and (eyedropper only) the pixel underneath. */
  onCursorMove?: (info: { img: ImgPoint; clientX: number; clientY: number; rgb: Rgb | null } | null) => void;
  onOcrRegion?: (rect: { x: number; y: number; w: number; h: number }) => void;
  /** Fires when the eyedropper samples a pixel; screen coords position the popover. */
  onPickColor?: (rgb: Rgb, screenX: number, screenY: number) => void;
  /** Bakes the pending crop into the image -- owned by Editor since it's
   * the one holding the ImageBitmap this store can't touch. */
  onConfirmCrop: () => void;
  /** Whether highlight drags should snap to OCR'd text lines. */
  snapToText?: boolean;
  /** Word boxes for the current image, or null while they are still being
   * fetched -- a drag during that window stays freeform rather than waiting. */
  textBoxes?: OcrWordBox[] | null;
}

interface DragState {
  start: ImgPoint;
  moving?: { shapeId: string; origShape: Shape };
  resizing?: { shapeId: string; handle: HandleId; origShape: Shape };
  cropResizing?: { handle: RectHandleId; orig: PhysRect };
  cropMoving?: { orig: PhysRect };
  measuring?: boolean;
}

// Sized for two `size="md"` IconButtons (36px, matching the overlay's
// confirm/cancel/pin cluster) plus the gap between them.
const CROP_BUTTONS_W = 84;
const CROP_BUTTONS_H = 36;

interface TextEdit {
  point: ImgPoint;
  /** Id of the existing text shape being edited, or null when placing new text. */
  editingId: string | null;
  color: string;
  fontSize: number;
}

/** Debounces a rapidly-changing value, for the sharpness convolution that is
 * too costly to rerun on every slider frame. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}

const HANDLE_HIT_CSS_PX = 10;
/** Snap pull distance, in CSS pixels so it feels the same at any zoom. */
const SNAP_THRESHOLD_CSS_PX = 6;

export function Canvas({
  baseImage,
  onCursorMove,
  onOcrRegion,
  onPickColor,
  onConfirmCrop,
  snapToText = false,
  textBoxes = null,
}: CanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const annCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [textValue, setTextValue] = useState("");
  // Bumped when an inserted image finishes decoding: image shapes draw
  // nothing on the render that first requests them, so without a re-render
  // they'd stay invisible until unrelated state happened to change.
  const [imageTick, setImageTick] = useState(0);
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);
  // Bumped when the adjusted base canvas is repainted, so the annotation
  // layer re-renders and censor/loupe shapes resample the new pixels.
  const [baseTick, setBaseTick] = useState(0);

  // Explicit imperative focus, deferred to a macrotask. The textarea can't
  // use `autoFocus`: its synchronous focus-on-mount fires mid-pointerdown,
  // and the browser's own focus-follows-click settling for that same click
  // happens after, on mouseup -- stealing focus back and firing this
  // textarea's onBlur (which commits/cancels the edit) before the click even
  // finishes. Deferring past that with setTimeout(0) lets our focus call win
  // instead of racing it.
  useEffect(() => {
    if (!textEdit) return;
    const id = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [textEdit]);

  const {
    imageWidth,
    imageHeight,
    shapes,
    draft,
    tool,
    style,
    zoom,
    selectedId,
    cropRect,
    ocrRect,
    measureLine,
    backdrop,
    adjustments,
    setDraft,
    addShape,
    addShapes,
    updateShape,
    removeShape,
    select,
    setTool,
    setCropRect,
    setOcrRect,
    setMeasureLine,
  } = useEditorStore();

  // The visible base canvas carries the adjustments: they must be applied
  // here (not only at export) so the canvas shows what will be saved.
  // Sharpness is the expensive term, so slider drags settle for `debounced`
  // before it runs; the cheap filter terms apply on every frame.
  const debouncedSharpness = useDebounced(adjustments.sharpness, 150);
  const liveAdjustments = { ...adjustments, sharpness: debouncedSharpness };

  useEffect(() => {
    const c = baseCanvasRef.current;
    if (!c) return;
    c.width = imageWidth;
    c.height = imageHeight;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(baseImage, 0, 0);
    if (!isIdentity(liveAdjustments)) {
      const adjusted = applyAdjustments(c, liveAdjustments);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(adjusted, 0, 0);
    }
    // Shapes that sample the image (censor, loupe) read this same canvas, so
    // they pick up the adjustments without any extra plumbing.
    setBaseTick((n) => n + 1);
  }, [
    baseImage,
    imageWidth,
    imageHeight,
    liveAdjustments.brightness,
    liveAdjustments.contrast,
    liveAdjustments.saturation,
    liveAdjustments.sharpness,
    liveAdjustments.invert,
    liveAdjustments.preset,
  ]);

  // Entering the Crop tool with no crop in progress starts from the full
  // image -- the user narrows it down via the resize handles instead of
  // drawing one from scratch.
  useEffect(() => {
    if (tool === "crop" && !cropRect && imageWidth > 0 && imageHeight > 0) {
      setCropRect({ x: 0, y: 0, w: imageWidth, h: imageHeight });
    }
  }, [tool, cropRect, imageWidth, imageHeight, setCropRect]);

  const editingId = textEdit?.editingId ?? null;

  useEffect(() => {
    const c = annCanvasRef.current;
    if (!c) return;
    c.width = imageWidth;
    c.height = imageHeight;
    const ctx = c.getContext("2d")!;
    // The shape being edited is hidden here -- it's shown "live" by the
    // textarea overlay instead, so rendering it too would double it up.
    const visible = shapes.filter((sh) => sh.id !== editingId);
    if (draft) visible.push(draft);
    render(ctx, visible, {
      // The adjusted canvas, not the raw bitmap: a censor or loupe sampling
      // the original would show unadjusted pixels inside an adjusted image.
      baseImage: baseCanvasRef.current ?? baseImage,
      selectedId,
      onImageLoad: () => setImageTick((n) => n + 1),
    });

    const selectedShape = selectedId ? shapes.find((sh) => sh.id === selectedId) : null;
    if (selectedShape) {
      drawSelectionOutline(ctx, selectedShape);
      if (tool === "select") drawHandles(ctx, selectedShape);
    }
    if (cropRect) {
      drawRegionOverlay(ctx, cropRect, imageWidth, imageHeight, accentColor());
      if (tool === "crop") {
        drawThirdsGrid(ctx, cropRect, zoom);
        drawHandlesAt(ctx, clampHandles(rectHandles(cropRect), imageWidth, imageHeight));
      }
    }
    if (ocrRect) {
      drawRegionOverlay(ctx, ocrRect, imageWidth, imageHeight, "#22c55e");
    }
    if (measureLine) {
      drawMeasureLine(ctx, measureLine, zoom);
    }
    if (alignGuides.length > 0) {
      drawAlignGuides(ctx, alignGuides, imageWidth, imageHeight, zoom);
    }
  }, [shapes, draft, baseImage, imageWidth, imageHeight, selectedId, cropRect, ocrRect, measureLine, zoom, tool, editingId, imageTick, alignGuides, baseTick]);

  /** Colour of one image pixel *as displayed*: base bitmap with the
   * annotation layer composited over it, so picking inside a spotlight's dim
   * or a highlighter stroke returns what the eye sees, not what's underneath. */
  const samplePixelAt = useCallback((p: ImgPoint): Rgb | null => {
    const base = baseCanvasRef.current;
    const ann = annCanvasRef.current;
    if (!base || !ann) return null;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= base.width || y >= base.height) return null;
    const tmp = document.createElement("canvas");
    tmp.width = 1;
    tmp.height = 1;
    const ctx = tmp.getContext("2d")!;
    ctx.drawImage(base, x, y, 1, 1, 0, 0, 1, 1);
    ctx.drawImage(ann, x, y, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }, []);

  const getScale = useCallback(() => {
    const el = annCanvasRef.current!;
    const rect = el.getBoundingClientRect();
    return { sx: el.width / rect.width, sy: el.height / rect.height };
  }, []);

  const toImagePoint = useCallback((e: { clientX: number; clientY: number }): ImgPoint => {
    const el = annCanvasRef.current!;
    const rect = el.getBoundingClientRect();
    const { sx, sy } = getScale();
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }, [getScale]);

  function handlePointerDown(e: React.PointerEvent) {
    const p = toImagePoint(e);

    // A click anywhere else on the canvas -- placing new text, drawing a
    // shape, switching selection -- saves whatever text edit was in
    // progress instead of silently discarding it. Clicks inside the
    // textarea itself never reach here (it sits above the canvas in the
    // DOM), so this only fires for genuine "click outside" cases.
    if (textEdit) commitText();

    if (tool === "text") {
      // No pointer capture here -- placing text doesn't drag, and capturing
      // the pointer to the canvas isn't needed before handing focus off to
      // the textarea below.
      setTextEdit({ point: p, editingId: null, color: style.stroke, fontSize: style.fontSize });
      setTextValue("");
      return;
    }

    (e.target as Element).setPointerCapture(e.pointerId);

    if (tool === "select") {
      const selectedShape = selectedId ? shapes.find((sh) => sh.id === selectedId) : null;
      if (selectedShape) {
        const { sx } = getScale();
        const handle = pickHandle(handlesFor(selectedShape), p, HANDLE_HIT_CSS_PX * sx);
        if (handle) {
          dragRef.current = { start: p, resizing: { shapeId: selectedShape.id, handle, origShape: selectedShape } };
          return;
        }
      }
      const hit = pickShape(shapes, p);
      if (hit) {
        // Ctrl+drag duplicates: the copy is what moves with the pointer and
        // the original stays put. Ctrl rather than the more common Alt
        // because XFCE's window manager claims Alt+drag for moving windows,
        // so the app never sees it. Nothing else in the editor binds a
        // Ctrl+pointer gesture (Ctrl+wheel zoom is a different gesture).
        const target = e.ctrlKey ? cloneShape(hit) : hit;
        if (e.ctrlKey) addShape(target);
        select(target.id);
        dragRef.current = { start: p, moving: { shapeId: target.id, origShape: target } };
      } else {
        select(null);
      }
      return;
    }

    if (tool === "crop") {
      if (!cropRect) return;
      const { sx } = getScale();
      const handle = pickHandle(clampHandles(rectHandles(cropRect), imageWidth, imageHeight), p, HANDLE_HIT_CSS_PX * sx);
      if (handle) {
        dragRef.current = { start: p, cropResizing: { handle: handle as RectHandleId, orig: cropRect } };
      } else if (p.x >= cropRect.x && p.x <= cropRect.x + cropRect.w && p.y >= cropRect.y && p.y <= cropRect.y + cropRect.h) {
        dragRef.current = { start: p, cropMoving: { orig: cropRect } };
      } else {
        dragRef.current = null;
      }
      return;
    }

    if (tool === "marker") {
      // Provisional number; `addShape` re-derives it from position so the
      // sequence stays 1..n after deletions.
      const nextNumber = shapes.filter((s) => s.kind === "marker").length + 1;
      addShape(createMarker(crypto.randomUUID(), p, nextNumber, style));
      return;
    }

    if (tool === "stamp") {
      addShape(createStamp(crypto.randomUUID(), p, style));
      // Recording on placement (not on picking) means the recents list
      // reflects what was actually used, not what was merely browsed.
      pushRecentStamp(style.stampEmoji);
      return;
    }

    if (tool === "eyedropper") {
      const rgb = samplePixelAt(p);
      if (rgb) onPickColor?.(rgb, e.clientX, e.clientY);
      dragRef.current = null;
      return;
    }

    if (tool === "measure") {
      dragRef.current = { start: p, measuring: true };
      setMeasureLine({ start: p, end: p });
      return;
    }

    // Clear any leftover selection from a shape drawn earlier with this same
    // tool -- otherwise the properties panel keeps showing that old shape's
    // fields for the duration of this drag instead of the tool's defaults.
    select(null);
    dragRef.current = { start: p };

    if (tool === "freehand") {
      setDraft(startFreehand(crypto.randomUUID(), p, style));
    } else if (tool === "ocr") {
      setOcrRect(null);
    } else {
      setDraft(makeDraft(tool, p, p, style, e.shiftKey));
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    const p = toImagePoint(e);
    // Sampling is a 1x1 getImageData, cheap, but only the eyedropper needs a
    // live colour -- every other tool would pay for it on every move.
    onCursorMove?.({
      img: p,
      clientX: e.clientX,
      clientY: e.clientY,
      rgb: tool === "eyedropper" ? samplePixelAt(p) : null,
    });
    const drag = dragRef.current;
    if (!drag) return;

    if (tool === "select" && drag.resizing) {
      updateShape(drag.resizing.shapeId, resizeShape(drag.resizing.origShape, drag.resizing.handle, p, e.shiftKey));
      return;
    }

    if (tool === "select" && drag.moving) {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const moved = moveShape(drag.moving.origShape, dx, dy);
      // Alt is the documented bypass, matching the region overlay's edge
      // snapping, so a shape can always be placed at an exact free position.
      if (e.altKey) {
        setAlignGuides([]);
        updateShape(drag.moving.shapeId, moved);
        return;
      }
      // Rotated shapes participate through their on-screen bounding box --
      // what the user is actually lining up is what they can see.
      const others = shapes.filter((s) => s.id !== drag.moving!.shapeId).map(rotatedBounds);
      const { sx } = getScale();
      const snap = snapShapeDrag(rotatedBounds(moved), others, imageWidth, imageHeight, SNAP_THRESHOLD_CSS_PX * sx);
      setAlignGuides(snap.guides);
      updateShape(drag.moving.shapeId, moveShape(drag.moving.origShape, dx + snap.dx, dy + snap.dy));
      return;
    }

    if (tool === "freehand") {
      // Read live state, not the closure-captured `draft`: on the first
      // move after mousedown the closure can still see the pre-mousedown
      // render, which would otherwise wipe the just-started stroke.
      const live = useEditorStore.getState().draft;
      if (live?.kind === "freehand") {
        setDraft(extendFreehand(live, p));
      }
      return;
    }

    if (tool === "crop" && drag.cropResizing) {
      setCropRect(resizeCropRect(drag.cropResizing.orig, drag.cropResizing.handle, p, imageWidth, imageHeight));
      return;
    }

    if (tool === "crop" && drag.cropMoving) {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      setCropRect(moveCropRect(drag.cropMoving.orig, dx, dy, imageWidth, imageHeight));
      return;
    }

    if (tool === "measure" && drag.measuring) {
      // Shift locks to the dominant axis, for a pure width or height.
      const end = e.shiftKey
        ? Math.abs(p.x - drag.start.x) >= Math.abs(p.y - drag.start.y)
          ? { x: p.x, y: drag.start.y }
          : { x: drag.start.x, y: p.y }
        : p;
      setMeasureLine({ start: drag.start, end });
      return;
    }

    if (tool === "crop") return;

    if (tool === "ocr") {
      setOcrRect(createCropRect(drag.start, p, imageWidth, imageHeight));
      return;
    }

    // `drag` (from the ref) is already confirmed truthy above; don't gate
    // on the closure-captured `draft` store value here -- it can still
    // reflect the pre-mousedown render on the first move event, silently
    // dropping the update instead of growing the draft shape.
    setDraft(makeDraft(tool, drag.start, p, style, e.shiftKey));
  }

  function handlePointerUp(e: React.PointerEvent) {
    const target = e.target as Element;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
    if (tool === "select") {
      dragRef.current = null;
      // Guides are a live drag affordance -- leaving them drawn would read
      // as part of the annotation.
      setAlignGuides([]);
      return;
    }
    if (tool === "crop" || tool === "measure" || tool === "eyedropper") {
      dragRef.current = null;
      return;
    }
    if (tool === "ocr") {
      dragRef.current = null;
      const rect = useEditorStore.getState().ocrRect;
      if (rect && rect.w >= 4 && rect.h >= 4) {
        onOcrRegion?.(rect);
      }
      return;
    }
    const live = useEditorStore.getState().draft;
    if (live) {
      // A snapped highlight can become several shapes (one per text line),
      // so it commits as a batch; everything else is a single shape.
      const snapped = live.kind === "highlight" ? snapHighlight(live) : null;
      if (snapped && snapped.length > 0) {
        addShapes(snapped);
      } else {
        // `live` still carries makeDraft's placeholder id "draft" (reused for
        // every in-progress shape so it doesn't need a fresh id on every
        // pointermove) -- assign the real id only once, on commit. Skipping
        // this meant every drawn shape shared literal id "draft", so
        // updateShape/removeShape (which key off shape.id) affected *all* of
        // them at once instead of just the one being interacted with.
        addShape({ ...live, id: crypto.randomUUID() });
      }
      setDraft(null);
    }
    dragRef.current = null;
  }

  /** Snapped replacements for a freeform highlight drag, or null when
   * snapping is off, the boxes have not arrived yet, or the drag crossed no
   * text -- in every one of those cases the caller keeps the freeform rect
   * rather than dropping the gesture. */
  function snapHighlight(draftShape: Shape & { kind: "highlight" }): Shape[] | null {
    if (!snapToText) return null;
    const boxes = textBoxes;
    if (!boxes || boxes.length === 0) return null;
    const rects = snapHighlightToLines(draftShape, clusterWordsToLines(boxes));
    if (rects.length === 0) return null;
    return rects.map((r) => ({ ...draftShape, ...r, id: crypto.randomUUID() }));
  }

  function handleDoubleClick(e: React.MouseEvent) {
    if (tool !== "select") return;
    const p = toImagePoint(e);

    // Double-clicking a curved arrow's control handle straightens it -- the
    // only way back, since dragging the handle can only ever set a curve.
    const selected = selectedId ? shapes.find((s) => s.id === selectedId) : null;
    if (selected?.kind === "arrow" && selected.curve) {
      const { sx } = getScale();
      if (pickHandle(handlesFor(selected), p, HANDLE_HIT_CSS_PX * sx) === "mid") {
        updateShape(selected.id, { curve: undefined });
        return;
      }
    }

    const hit = pickShape(shapes, p);
    if (!hit || hit.kind !== "text") return;
    select(null);
    dragRef.current = null;
    setTextEdit({ point: { x: hit.x, y: hit.y }, editingId: hit.id, color: hit.color, fontSize: hit.fontSize });
    setTextValue(hit.text);
  }

  function commitText() {
    if (!textEdit) return;
    if (textEdit.editingId) {
      if (textValue.trim()) {
        updateShape(textEdit.editingId, { text: textValue });
      } else {
        removeShape(textEdit.editingId);
      }
    } else if (textValue.trim()) {
      addShape(
        createText(crypto.randomUUID(), textEdit.point, textValue, textEdit.color, textEdit.fontSize, style),
      );
    }
    setTextEdit(null);
    setTextValue("");
  }

  function cancelCrop() {
    setCropRect(null);
    setTool("select");
  }

  const cssWidth = imageWidth * zoom;
  const cssHeight = imageHeight * zoom;

  // Anchored to the crop rect's bottom-right corner, clamped so it never
  // renders outside the visible canvas -- otherwise a full-size (or
  // near-edge) crop would push the buttons off-screen.
  let cropButtonsLeft = 0;
  let cropButtonsTop = 0;
  if (cropRect) {
    const rawLeft = (cropRect.x + cropRect.w) * zoom - CROP_BUTTONS_W;
    const rawTop = (cropRect.y + cropRect.h) * zoom + 8;
    cropButtonsLeft = Math.min(Math.max(0, rawLeft), Math.max(0, cssWidth - CROP_BUTTONS_W));
    cropButtonsTop = Math.min(Math.max(0, rawTop), Math.max(0, cssHeight - CROP_BUTTONS_H));
  }

  // Backdrop preview is CSS on a wrapper around the canvases, not extra
  // pixels inside them: the canvases stay exactly image-sized, so every
  // pointer/hit-test coordinate below keeps mapping 1:1 to image space.
  // `drawBackdrop` reproduces the same padding/preset/radius/shadow on a real
  // canvas at export time.
  const content = (
    <div
      // `flex-shrink-0`: this is a flex item inside a row container
      // (Editor's `flex items-center justify-center` canvas area). Without
      // it, once the image is wider than the available space (e.g. at
      // "Actual size"), flexbox's default shrink-on-the-main-axis behavior
      // squeezes this div's *width* down to fit while its height (the cross
      // axis, governed by `items-center`, which doesn't stretch/shrink) stays
      // at its full intrinsic value -- and since the canvases inside are
      // `w-full h-full` of this div, they inherit that now-mismatched box
      // and stretch their backing-store content to match. Fixed size on
      // both axes here; the container's `overflow-auto` handles the excess
      // via scrolling instead of a non-uniform squeeze.
      className="relative select-none touch-none shrink-0"
      style={{
        width: cssWidth,
        height: cssHeight,
        backgroundImage:
          "linear-gradient(45deg, var(--border) 25%, transparent 25%), linear-gradient(-45deg, var(--border) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--border) 75%), linear-gradient(-45deg, transparent 75%, var(--border) 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        boxShadow: backdrop.enabled && !backdrop.shadow ? "none" : "var(--shadow-lg)",
        borderRadius: backdrop.enabled ? backdrop.cornerRadius * zoom : undefined,
        overflow: backdrop.enabled ? "hidden" : undefined,
      }}
    >
      <canvas
        ref={baseCanvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ imageRendering: zoom > 1 ? "pixelated" : "auto" }}
      />
      <canvas
        ref={annCanvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ cursor: cursorFor(tool) }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => onCursorMove?.(null)}
        onDoubleClick={handleDoubleClick}
        // Ctrl+click is the macOS right-click convention, and a context menu
        // opening mid-gesture would abort a Ctrl+drag duplicate. Harmless on
        // Linux/Windows, where the canvas has no context menu of its own.
        onContextMenu={(e) => e.preventDefault()}
      />
      {textEdit && (
        <textarea
          ref={textareaRef}
          rows={Math.max(1, textValue.split("\n").length)}
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onBlur={(e) => {
            // A blur with no relatedTarget means focus went nowhere (the
            // canvas isn't focusable) -- that's the "clicked elsewhere on
            // the canvas" case, which handlePointerDown already commits
            // explicitly. Committing again here would race it: this event
            // can still fire after handlePointerDown has already opened a
            // *new* edit for the same click, and would wipe that back out.
            // A real relatedTarget (a toolbar button, etc.) means focus
            // moved to something that won't trigger our own commit, so it
            // still needs to happen here.
            if (e.relatedTarget) commitText();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setTextEdit(null);
              setTextValue("");
            } else if (e.key === "Enter" && e.ctrlKey) {
              commitText();
            }
          }}
          className="absolute bg-transparent border border-dashed border-[var(--accent)] outline-none resize-none p-0.5"
          style={{
            left: textEdit.point.x * zoom,
            top: textEdit.point.y * zoom,
            fontSize: textEdit.fontSize * zoom,
            color: textEdit.color,
            minWidth: 120,
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
          }}
        />
      )}
      {tool === "crop" && cropRect && (
        <div
          className="absolute flex items-center gap-1.5"
          style={{ left: cropButtonsLeft, top: cropButtonsTop }}
        >
          {/* Same size/variant as the region-capture overlay's confirm/cancel
           * cluster (`Overlay.tsx`) -- previously these were `size="sm"`
           * (32px) there vs. `size="md"` (36px) here, so confirming a
           * rectangular selection looked like two different controls
           * depending on whether you were in the capture overlay or the
           * editor's crop tool. */}
          <IconButton
            label="Cancel crop"
            icon={<X size={18} />}
            size="md"
            variant="secondary"
            className="shadow-[var(--shadow-md)]"
            onClick={cancelCrop}
          />
          <IconButton
            label="Confirm crop"
            icon={<Check size={18} />}
            size="md"
            variant="primary"
            className="shadow-[var(--shadow-md)]"
            onClick={onConfirmCrop}
          />
        </div>
      )}
    </div>
  );

  // The wrapper is always rendered, even with the backdrop off (when it's an
  // unstyled passthrough). Rendering it conditionally changed the DOM
  // structure around the canvases, so toggling the backdrop replaced both
  // canvas elements with fresh, blank ones -- and the effects that draw them
  // key off the image, which hadn't changed, so nothing ever repainted them.
  return (
    <div
      className="shrink-0"
      style={
        backdrop.enabled
          ? {
              padding: backdrop.padding * zoom,
              background: presetCss(backdrop.preset),
              boxShadow: "var(--shadow-lg)",
            }
          : undefined
      }
    >
      {content}
    </div>
  );
}

function makeDraft(
  tool: string,
  start: ImgPoint,
  current: ImgPoint,
  style: import("./types").Style,
  constrain: boolean,
): Shape | null {
  const id = "draft";
  switch (tool) {
    case "rect":
      return createRect(id, start, current, style, constrain);
    case "ellipse":
      return createEllipse(id, start, current, style, constrain);
    // Line is the Arrow tool starting from the headless style: one shape,
    // one factory, and the head dropdown drives whichever tool is active.
    case "arrow":
    case "line":
      return createArrow(id, start, current, style, constrain);
    case "highlight":
      return createHighlight(id, start, current, style);
    case "pixelate":
      return createPixelate(id, start, current, style);
    case "spotlight":
      return createSpotlight(id, start, current, style);
    case "loupe":
      return createLoupe(id, start, current, style);
    default:
      return null;
  }
}

function cursorFor(tool: string): string {
  switch (tool) {
    case "select":
      return "default";
    case "text":
      return "text";
    default:
      return "crosshair";
  }
}

function accentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3b6fe0";
}

function drawSelectionOutline(ctx: CanvasRenderingContext2D, s: Shape) {
  const b = shapeBounds(s);
  ctx.save();
  // The outline turns with the shape, so it keeps hugging the shape's own
  // edges rather than growing into a loose axis-aligned box around it.
  const rotation = rotationOf(s);
  if (rotation !== 0) {
    const c = rotationCenter(s);
    ctx.translate(c.x, c.y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-c.x, -c.y);
  }
  ctx.strokeStyle = accentColor();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
  ctx.restore();
}

function drawHandles(ctx: CanvasRenderingContext2D, s: Shape) {
  drawHandlesAt(ctx, handlesFor(s));
}

function drawHandlesAt(ctx: CanvasRenderingContext2D, handles: { id?: HandleId; x: number; y: number }[]) {
  if (handles.length === 0) return;
  const size = 8;
  ctx.save();
  const accent = accentColor();
  for (const h of handles) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // The rotate handle is round so it reads as a different kind of grip
    // than the square resize handles it sits next to.
    if (h.id === "rotate") {
      ctx.arc(h.x, h.y, size / 2, 0, Math.PI * 2);
    } else {
      ctx.rect(h.x - size / 2, h.y - size / 2, size, size);
    }
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Rule-of-thirds guides inside the crop rect. Editing chrome only: the
 * export re-renders shapes without any of this (see `flattenToPng`). */
function drawThirdsGrid(ctx: CanvasRenderingContext2D, rect: PhysRect, zoom: number) {
  ctx.save();
  ctx.strokeStyle = accentColor();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1 / Math.max(zoom, 0.01);
  for (let i = 1; i <= 2; i++) {
    const x = rect.x + (rect.w * i) / 3;
    const y = rect.y + (rect.h * i) / 3;
    ctx.beginPath();
    ctx.moveTo(x, rect.y);
    ctx.lineTo(x, rect.y + rect.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.w, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Alignment guides shown while a shape is being dragged into line with
 * another. Line width is divided by `zoom` so the guide stays hairline-thin
 * on screen regardless of how far the capture is zoomed. */
function drawAlignGuides(
  ctx: CanvasRenderingContext2D,
  guides: AlignGuide[],
  imageWidth: number,
  imageHeight: number,
  zoom: number,
) {
  ctx.save();
  ctx.strokeStyle = accentColor();
  ctx.lineWidth = 1 / Math.max(zoom, 0.01);
  for (const g of guides) {
    ctx.beginPath();
    if (g.axis === "x") {
      ctx.moveTo(g.position, 0);
      ctx.lineTo(g.position, imageHeight);
    } else {
      ctx.moveTo(0, g.position);
      ctx.lineTo(imageWidth, g.position);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Measurement line with endpoint dots and a distance label. Stroke widths,
 * dot radii and font size are divided by `zoom` because this draws into the
 * image-resolution canvas, which is then scaled on screen -- without it the
 * readout would shrink to nothing on a zoomed-out capture. */
function drawMeasureLine(ctx: CanvasRenderingContext2D, line: MeasureLine, zoom: number) {
  const accent = accentColor();
  const px = (n: number) => n / Math.max(zoom, 0.01);
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = px(2);
  ctx.beginPath();
  ctx.moveTo(line.start.x, line.start.y);
  ctx.lineTo(line.end.x, line.end.y);
  ctx.stroke();

  for (const p of [line.start, line.end]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, px(4), 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.stroke();
  }

  const label = measurementLabel(line.start, line.end);
  const fontSize = px(13);
  // A literal family list, not `var(--font-mono)`: canvas parses this string
  // itself and has no CSS variables, so an unresolvable family makes the
  // whole assignment a no-op and the label silently falls back to the
  // default 10px font.
  ctx.font = `600 ${fontSize}px ui-monospace, "Cascadia Code", Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const midX = (line.start.x + line.end.x) / 2;
  const midY = Math.min(line.start.y, line.end.y) - px(10);
  const padding = px(6);
  const width = ctx.measureText(label).width + padding * 2;
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(midX - width / 2, midY - fontSize - padding, width, fontSize + padding * 2);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, midX, midY + padding / 2);
  ctx.restore();
}

function drawRegionOverlay(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number,
  strokeColor: string,
) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, imgW, rect.y);
  ctx.fillRect(0, rect.y + rect.h, imgW, imgH - rect.y - rect.h);
  ctx.fillRect(0, rect.y, rect.x, rect.h);
  ctx.fillRect(rect.x + rect.w, rect.y, imgW - rect.x - rect.w, rect.h);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  // Inset by half a pixel so the stroke stays fully on-canvas (and crisp)
  // even when `rect` touches the image edge -- a 1px line centered exactly
  // on the boundary would have half its width clipped off otherwise.
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
  ctx.restore();
}
