import { create } from "zustand";
import type { PhysRect } from "../lib/geometry";
import type { Backdrop, MeasureLine, Shape, Style, ToolId } from "./types";
import { cloneShape, moveShape } from "./tools/select";

/** One undo step. Backdrop rides along with the shapes so toggling or
 * restyling the frame is undoable like any other edit. */
interface HistoryEntry {
  shapes: Shape[];
  backdrop: Backdrop;
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
  /** Percent of native size the export is scaled to (100 = untouched). */
  exportScale: number;
  past: HistoryEntry[];
  future: HistoryEntry[];
  zoom: number;
  cropRect: PhysRect | null;
  ocrRect: PhysRect | null;
  measureLine: MeasureLine | null;
  dirty: boolean;
  markerCounter: number;

  setImage: (id: string, width: number, height: number) => void;
  setTool: (tool: ToolId) => void;
  setStyle: (partial: Partial<Style>) => void;
  setBackdrop: (partial: Partial<Backdrop>) => void;
  setExportScale: (percent: number) => void;
  setDraft: (shape: Shape | null) => void;
  commitDraft: () => void;
  addShape: (shape: Shape) => void;
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
  nextMarkerNumber: () => number;
}

const DEFAULT_STYLE: Style = {
  stroke: "#e2372f",
  fill: null,
  strokeWidth: 3,
  fontSize: 20,
  opacity: 1,
  pixelateBlock: 12,
  markerSize: 14,
  spotlightDim: 0.6,
  spotlightForm: "rect",
};

const DEFAULT_BACKDROP: Backdrop = {
  enabled: false,
  padding: 48,
  preset: "violet",
  cornerRadius: 12,
  shadow: true,
};

function snapshot(state: { shapes: Shape[]; backdrop: Backdrop }): HistoryEntry {
  return { shapes: state.shapes.map((s) => ({ ...s })), backdrop: { ...state.backdrop } };
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
  exportScale: 100,
  past: [],
  future: [],
  zoom: 1,
  cropRect: null,
  ocrRect: null,
  measureLine: null,
  dirty: false,
  markerCounter: 0,

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
      markerCounter: 0,
      backdrop: DEFAULT_BACKDROP,
    }),
  setTool: (tool) =>
    set({
      tool,
      selectedId: tool === "select" ? get().selectedId : null,
      // The measurement is a read-out for the measure tool specifically;
      // leaving it drawn under another tool reads as a stray annotation.
      measureLine: tool === "measure" ? get().measureLine : null,
    }),
  setStyle: (partial) => set((s) => ({ style: { ...s.style, ...partial } })),

  setBackdrop: (partial) =>
    set((s) => ({
      backdrop: { ...s.backdrop, ...partial },
      past: [...s.past, snapshot(s)],
      future: [],
      dirty: true,
    })),

  setExportScale: (percent) => set({ exportScale: percent }),
  setDraft: (shape) => set({ draft: shape }),

  commitDraft: () => {
    const draft = get().draft;
    if (!draft) return;
    get().addShape(draft);
    set({ draft: null });
  },

  addShape: (shape) =>
    set((s) => ({
      shapes: [...s.shapes, shape],
      past: [...s.past, snapshot(s)],
      future: [],
      dirty: true,
      selectedId: shape.id,
    })),

  updateShape: (id, partial) =>
    set((s) => ({
      shapes: s.shapes.map((sh) => (sh.id === id ? ({ ...sh, ...partial } as Shape) : sh)),
      dirty: true,
    })),

  removeShape: (id) =>
    set((s) => ({
      shapes: s.shapes.filter((sh) => sh.id !== id),
      past: [...s.past, snapshot(s)],
      future: [],
      selectedId: null,
      dirty: true,
    })),

  select: (id) => set({ selectedId: id }),

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

  setOcrRect: (rect) => set({ ocrRect: rect }),

  setMeasureLine: (line) => set({ measureLine: line }),

  nextMarkerNumber: () => {
    const n = get().markerCounter + 1;
    set({ markerCounter: n });
    return n;
  },
}));
