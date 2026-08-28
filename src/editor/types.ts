export type ToolId =
  | "select"
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "freehand"
  | "text"
  | "highlight"
  | "pixelate"
  | "spotlight"
  | "marker"
  | "crop"
  | "ocr"
  | "eyedropper"
  | "measure";

export interface Style {
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  pixelateBlock: number;
  markerSize: number;
  /** 0..1 darkness of the area *outside* spotlight shapes. */
  spotlightDim: number;
  spotlightForm: SpotlightForm;
  /** Corner radius (image-space px) for new rectangles and rect-form
   * spotlights. Rendering clamps it to half the shape's smaller side, so a
   * value larger than the shape can hold just reads as fully rounded. */
  radius: number;
}

export interface ImgPoint {
  x: number;
  y: number;
}

/** A transient measurement drawn over the image, in image-space pixels. Not
 * a `Shape`: it's a read-out, so it isn't selectable and never exports. */
export interface MeasureLine {
  start: ImgPoint;
  end: ImgPoint;
}

/** Presentation frame composited around the image at export time (and
 * previewed via CSS on the canvas wrapper). Document-level state rather than
 * a `Shape`: it has no z-order, can't be selected, and there's only ever one. */
export interface Backdrop {
  enabled: boolean;
  /** Image-space pixels of background on every side. */
  padding: number;
  /** `BackdropPreset.id` from `tools/backdrop.ts`. */
  preset: string;
  cornerRadius: number;
  shadow: boolean;
}

interface ShapeBase {
  id: string;
}

export interface RectShape extends ShapeBase {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  /** Optional so shapes drawn before this existed (and history snapshots
   * holding them) stay valid; `undefined` renders as square corners. */
  radius?: number;
}

export interface EllipseShape extends ShapeBase {
  kind: "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  fill: string | null;
  strokeWidth: number;
}

export interface ArrowShape extends ShapeBase {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface LineShape extends ShapeBase {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface FreehandShape extends ShapeBase {
  kind: "freehand";
  points: ImgPoint[];
  stroke: string;
  strokeWidth: number;
}

export interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  background: boolean;
}

export interface HighlightShape extends ShapeBase {
  kind: "highlight";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface PixelateShape extends ShapeBase {
  kind: "pixelate";
  x: number;
  y: number;
  w: number;
  h: number;
  blockSize: number;
}

export interface MarkerShape extends ShapeBase {
  kind: "marker";
  x: number;
  y: number;
  number: number;
  color: string;
  radius: number;
}

/** Outline the spotlight hole is cut to, within its bounding box. */
export type SpotlightForm = "rect" | "ellipse";

/** A hole in the dim layer: everything *outside* every spotlight is darkened
 * by `dimOpacity`. Multiple spotlights share one dim layer (the strongest
 * `dimOpacity` wins) rather than stacking, so two overlapping spotlights read
 * as two windows onto the same image, not a darker patch. */
export interface SpotlightShape extends ShapeBase {
  kind: "spotlight";
  x: number;
  y: number;
  w: number;
  h: number;
  dimOpacity: number;
  form: SpotlightForm;
  /** Corner radius of the punched-out hole. Only meaningful for
   * `form: "rect"` -- the ellipse form is already fully round. */
  radius?: number;
}

export interface ImageShape extends ShapeBase {
  kind: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
}

export type Shape =
  | RectShape
  | EllipseShape
  | ArrowShape
  | LineShape
  | FreehandShape
  | TextShape
  | HighlightShape
  | PixelateShape
  | SpotlightShape
  | ImageShape
  | MarkerShape;

export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate":
    case "spotlight":
    case "image":
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case "arrow":
    case "line":
      return {
        x: Math.min(s.x1, s.x2),
        y: Math.min(s.y1, s.y2),
        w: Math.abs(s.x2 - s.x1),
        h: Math.abs(s.y2 - s.y1),
      };
    case "freehand": {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case "text": {
      const lines = s.text.split("\n");
      const longest = Math.max(0, ...lines.map((l) => l.length));
      return { x: s.x, y: s.y, w: s.fontSize * longest * 0.6, h: s.fontSize * 1.3 * lines.length };
    }
    case "marker":
      return { x: s.x - s.radius, y: s.y - s.radius, w: s.radius * 2, h: s.radius * 2 };
  }
}

/** 8 resize-handle positions (image-space) for a rect-like bounding box. */
export type RectHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type EndpointHandleId = "start" | "end";
export type HandleId = RectHandleId | EndpointHandleId;

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
}

export type RectLikeShape =
  | RectShape
  | EllipseShape
  | HighlightShape
  | PixelateShape
  | SpotlightShape
  | ImageShape
  | FreehandShape;
export type EndpointShape = ArrowShape | LineShape;

const RECT_LIKE_KINDS = new Set<Shape["kind"]>([
  "rect",
  "ellipse",
  "highlight",
  "pixelate",
  "spotlight",
  "image",
  "freehand",
]);

/** Shapes with a resizable bounding box (corner/edge drag handles). */
export function isRectLike(s: Shape): s is RectLikeShape {
  return RECT_LIKE_KINDS.has(s.kind);
}

/** Shapes resized by dragging their two endpoints directly. */
export function isEndpointLike(s: Shape): s is EndpointShape {
  return s.kind === "arrow" || s.kind === "line";
}

/** The 8 corner/edge handle positions for an arbitrary rect, shared by
 * rect-like shapes and the crop rect (which has no `Shape` of its own). */
export function rectHandles(b: { x: number; y: number; w: number; h: number }): Handle[] {
  const { x, y, w, h } = b;
  return [
    { id: "nw", x, y },
    { id: "n", x: x + w / 2, y },
    { id: "ne", x: x + w, y },
    { id: "e", x: x + w, y: y + h / 2 },
    { id: "se", x: x + w, y: y + h },
    { id: "s", x: x + w / 2, y: y + h },
    { id: "sw", x, y: y + h },
    { id: "w", x, y: y + h / 2 },
  ];
}

/** Nudges handle positions inward so they stay fully paintable (and
 * clickable at their painted position) even when the bounds they belong to
 * touch the edge of the canvas -- a plain <canvas> can't draw outside its
 * own backing-store dimensions, so a handle centered exactly on the image
 * edge would have half its square clipped off. Only affects where the
 * handle is drawn/hit-tested, not the resize math, which keys off the
 * handle's `id` and the live pointer position, not its original coordinates. */
export function clampHandles(handles: Handle[], canvasW: number, canvasH: number, inset = 5): Handle[] {
  return handles.map((h) => ({
    ...h,
    x: Math.min(Math.max(h.x, inset), canvasW - inset),
    y: Math.min(Math.max(h.y, inset), canvasH - inset),
  }));
}

export function handlesFor(s: Shape): Handle[] {
  if (s.kind === "arrow" || s.kind === "line") {
    return [
      { id: "start", x: s.x1, y: s.y1 },
      { id: "end", x: s.x2, y: s.y2 },
    ];
  }
  if (!isRectLike(s)) return [];
  return rectHandles(shapeBounds(s));
}

export function hitTest(s: Shape, p: ImgPoint, pad = 6): boolean {
  const b = shapeBounds(s);
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}
