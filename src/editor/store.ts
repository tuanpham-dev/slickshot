import { create } from "zustand";
import type { PhysRect } from "../lib/geometry";
import type { Adjustments, Backdrop, MeasureLine, PanelOverride, Shape, Style, ToolId } from "./types";
import { IDENTITY_ADJUSTMENTS } from "./tools/adjust";
import { cloneShape, mirrorShape, moveShape } from "./tools/select";
import { renumberMarkers } from "./tools/marker";

/** One undo step. Backdrop rides along with the shapes so toggling or
 * restyling the frame is undoable like any other edit. */
interface HistoryEntry {
  shapes: Shape[];
  backdrop: Backdrop;
  adjustments: Adjustments;
}

interface EditorState {
  imageId: string | null;
  imageWidth: number;
  imageHeight: number;
  shapes: Shape[];
  draft: Shape | null;
  selectedId: string | null;
  tool: ToolId;
  style: Style;
  backdrop: Backdrop;
  adjustments: Adjustments;
  /** Explicit output dimensions for the exported image, or null to save at
   * the image's own size. Set from the Adjust panel's Resize field. */
  resize: { w: number; h: number } | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  zoom: number;
  /** Which document-level editor has taken over the properties panel, if
   * any. One field rather than a flag each, so Adjust and Backdrop cannot
   * both claim the panel. Lives in the store because every action that
   * changes what the panel should show -- picking a tool, selecting a shape
   * -- has to clear it, and doing that in one place keeps them consistent. */
  panelOverride: PanelOverride;
  cropRect: PhysRect | null;
  ocrRect: PhysRect | null;
  measureLine: MeasureLine | null;
  dirty: boolean;

  setImage: (id: string, width: number, height: number) => void;
  setTool: (tool: ToolId) => void;
  setStyle: (partial: Partial<Style>) => void;
  setBackdrop: (partial: Partial<Backdrop>) => void;
  setAdjustments: (partial: Partial<Adjustments>) => void;
  /** Mirrors `applyCrop`: bakes a horizontal or vertical flip into every
   * shape's coordinates. The caller replaces the base bitmap itself. */
  flipImage: (axis: "h" | "v") => void;
  setResize: (size: { w: number; h: number } | null) => void;
  setPanelOverride: (override: PanelOverride) => void;
  setDraft: (shape: Shape | null) => void;
  commitDraft: () => void;
  addShape: (shape: Shape) => void;
  /** Adds several shapes as a single undo step -- for actions that produce a
   * variable number of shapes at once (auto-redaction, snapped multi-line
   * highlights), where undoing should remove the whole batch rather than
   * peel it back one shape at a time. */
  addShapes: (shapes: Shape[]) => void;
  updateShape: (id: string, partial: Partial<Shape>) => void;
  removeShape: (id: string) => void;
  select: (id: string | null) => void;
  duplicateSelected: () => void;
  undo: () => void;
  redo: () => void;
  setZoom: (zoom: number) => void;
  setCropRect: (rect: PhysRect | null) => void;
  /** Bakes `rect` in as the new image bounds: shifts every shape so it
   * stays put visually, shrinks imageWidth/imageHeight to match, and clears
   * cropRect since the crop is now permanent rather than pending. The
   * caller is responsible for replacing the rendered base image itself
   * (this store has no access to the ImageBitmap). */
  applyCrop: (rect: PhysRect) => void;
  setOcrRect: (rect: PhysRect | null) => void;
  setMeasureLine: (line: MeasureLine | null) => void;
}

const DEFAULT_STYLE: Style = {
  stroke: "#e2372f",
  fill: null,
  strokeWidth: 3,
  fontSize: 20,
  opacity: 1,
  arrowStyle: "single",
  arrowBanner: false,
  textBold: false,
  textItalic: false,
  textUnderline: false,
  textAlign: "left",
  textBgColor: null,
  stampEmoji: "✅",
  loupeFactor: 2,
  pixelateBlock: 12,
  censorMode: "pixelate",
  censorColor: "#000000",
  markerSize: 14,
  spotlightDim: 0.6,
  spotlightForm: "rect",
  radius: 0,
};

const DEFAULT_BACKDROP: Backdrop = {
  enabled: false,
  padding: 48,
  preset: "violet",
  cornerRadius: 12,
  shadow: true,
};

function snapshot(state: { shapes: Shape[]; backdrop: Backdrop; adjustments: Adjustments }): HistoryEntry {
  return {
    shapes: state.shapes.map((s) => ({ ...s })),
    backdrop: { ...state.backdrop },
    adjustments: { ...state.adjustments },
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  imageId: null,
  imageWidth: 0,
  imageHeight: 0,
  shapes: [],
  draft: null,
  selectedId: null,
  tool: "select",
  style: DEFAULT_STYLE,
  backdrop: DEFAULT_BACKDROP,
  adjustments: IDENTITY_ADJUSTMENTS,
  resize: null,
  past: [],
  future: [],
  zoom: 1,
  panelOverride: null,
  cropRect: null,
  ocrRect: null,
  measureLine: null,
  dirty: false,

  // Resets all editing state along with the image: the editor window is
  // pre-warmed and reused across captures (see `editor::show` in Rust), so
  // a new image arriving must not inherit the previous capture's shapes,
  // history, crop, or dirty flag.
  setImage: (id, width, height) =>
    set({
      imageId: id,
      imageWidth: width,
      imageHeight: height,
      shapes: [],
      draft: null,
      selectedId: null,
      past: [],
      future: [],
      cropRect: null,
      ocrRect: null,
      measureLine: null,
      dirty: false,
      panelOverride: null,
      backdrop: DEFAULT_BACKDROP,
      adjustments: IDENTITY_ADJUSTMENTS,
      resize: null,
    }),
  setPanelOverride: (override) => set({ panelOverride: override }),

  setTool: (tool) =>
    set((s) => ({
      tool,
      // Picking a tool means wanting that tool's settings, so whichever
      // document-level editor holds the panel yields.
      panelOverride: null,
      selectedId: tool === "select" ? s.selectedId : null,
      // The measurement is a read-out for the measure tool specifically;
      // leaving it drawn under another tool reads as a stray annotation.
      measureLine: tool === "measure" ? s.measureLine : null,
      // Line and Arrow draw the same shape, so picking one only sets which
      // head you start from. Arrow leaves an existing head alone -- someone
      // who chose "double" keeps it -- and only steps in when the current
      // head would make it indistinguishable from the Line tool.
      style:
        tool === "line"
          ? { ...s.style, arrowStyle: "none" as const }
          : tool === "arrow" && s.style.arrowStyle === "none"
            ? { ...s.style, arrowStyle: "single" as const }
            : s.style,
    })),
  setStyle: (partial) => set((s) => ({ style: { ...s.style, ...partial } })),

  setBackdrop: (partial) =>
    set((s) => ({
      backdrop: { ...s.backdrop, ...partial },
      past: [...s.past, snapshot(s)],
      future: [],
      dirty: true,
    })),

  setAdjustments: (partial) =>
    set((s) => ({
      adjustments: { ...s.adjustments, ...partial },
      past: [...s.past, snapshot(s)],
      future: [],
      dirty: true,
    })),

  setResize: (size) => set({ resize: size, dirty: true }),
  setDraft: (shape) => set({ draft: shape }),

  commitDraft: () => {
    const draft = get().draft;
    if (!draft) return;
    get().addShape(draft);
    set({ draft: null });
  },

  // Renumbering runs on add as well as remove so a marker inserted after a
  // deletion (or a duplicated one, which arrives here via `duplicateSelected`
  // carrying a copy of its source's number) lands on the next free number
  // rather than repeating one.
  addShape: (shape) =>
    set((s) => ({
      shapes: renumberMarkers([...s.shapes, shape]),
      past: [...s.past, snapshot(s)],
      future: [],
      dirty: true,
      selectedId: shape.id,
    })),

  addShapes: (incoming) =>
    set((s) => {
      if (incoming.length === 0) return s;
      return {
        shapes: renumberMarkers([...s.shapes, ...incoming]),
        past: [...s.past, snapshot(s)],
        future: [],
        dirty: true,
        // A batch has no single subject to select; selecting the last one
        // would imply the others aren't part of the same action.
        selectedId: null,
      };
    }),

  updateShape: (id, partial) =>
    set((s) => ({
      shapes: s.shapes.map((sh) => (sh.id === id ? ({ ...sh, ...partial } as Shape) : sh)),
      dirty: true,
    })),

  removeShape: (id) =>
    set((s) => ({
      shapes: renumberMarkers(s.shapes.filter((sh) => sh.id !== id)),
      past: [...s.past, snapshot(s)],
      future: [],
      selectedId: null,
      dirty: true,
    })),

  // Selecting a shape asks for that shape's properties, so the panel is
  // handed back -- including when the same shape is clicked again, which a
  // check on `selectedId` changing would miss.
  select: (id) => set(id === null ? { selectedId: id } : { selectedId: id, panelOverride: null }),

  duplicateSelected: () => {
    const s = get();
    const shape = s.shapes.find((sh) => sh.id === s.selectedId);
    if (!shape) return;
    get().addShape(cloneShape(shape, 12, 12));
  },

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const previous = s.past[s.past.length - 1];
      return {
        shapes: previous.shapes,
        backdrop: previous.backdrop,
        adjustments: previous.adjustments,
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future],
        selectedId: null,
        dirty: true,
      };
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[0];
      return {
        shapes: next.shapes,
        backdrop: next.backdrop,
        adjustments: next.adjustments,
        past: [...s.past, snapshot(s)],
        future: s.future.slice(1),
        selectedId: null,
        dirty: true,
      };
    }),

  setZoom: (zoom) => set({ zoom: Math.min(Math.max(zoom, 0.1), 8) }),
  setCropRect: (rect) => set({ cropRect: rect, dirty: true }),

  applyCrop: (rect) =>
    set((s) => {
      const x = Math.round(rect.x);
      const y = Math.round(rect.y);
      const w = Math.round(rect.w);
      const h = Math.round(rect.h);
      return {
        shapes: s.shapes.map((sh) => moveShape(sh, -x, -y)),
        // Undo history from before the crop refers to shape positions and
        // an image size that no longer exist -- replaying it post-crop
        // would misplace every shape by the crop's offset. Cropping is a
        // fresh start for undo, the same way loading a new capture is.
        past: [],
        future: [],
        imageWidth: w,
        imageHeight: h,
        cropRect: null,
        selectedId: null,
        dirty: true,
      };
    }),

  // Baked immediately, like `applyCrop` rather than kept as pending state:
  // a flip the canvas doesn't show until export reads as broken, even when
  // the exported file is correct.
  flipImage: (axis) =>
    set((s) => ({
      shapes: s.shapes.map((sh) => mirrorShape(sh, axis, s.imageWidth, s.imageHeight)),
      // Pre-flip history holds coordinates in the un-mirrored frame; replaying
      // it would put every shape on the wrong side. Same reasoning as the
      // history reset in `applyCrop`.
      past: [],
      future: [],
      selectedId: null,
      dirty: true,
    })),

  setOcrRect: (rect) => set({ ocrRect: rect }),

  setMeasureLine: (line) => set({ measureLine: line }),
}));
