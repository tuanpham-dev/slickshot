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
  | "measure"
  | "stamp"
  | "loupe";

export interface Style {
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  /** Head treatment new arrows are created with. */
  arrowStyle: ArrowStyle;
  /** Whether new arrows use the tapered banner shaft. */
  arrowBanner: boolean;
  /** Formatting new text shapes are created with. */
  textBold: boolean;
  textItalic: boolean;
  textUnderline: boolean;
  textAlign: TextAlign;
  textBgColor: string | null;
  /** Emoji new stamps are placed with. */
  stampEmoji: string;
  /** Magnification new loupes are created with. */
  loupeFactor: number;
  pixelateBlock: number;
  /** Obscuring method new censor shapes are created with. */
  censorMode: CensorMode;
  /** Fill new solid-mode censor shapes are created with. */
  censorColor: string;
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

/** Non-destructive image adjustments. Document-level like `Backdrop`: there
 * is only ever one, it has no z-order, and it can't be selected. Applied
 * immediately to the on-screen canvas and identically at export, so what is
 * previewed is what is saved. */
export interface Adjustments {
  /** Percent, 100 = untouched. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 0..100; 0 = off. No CSS filter equivalent, so it runs as a convolution. */
  sharpness: number;
  invert: boolean;
  /** `AdjustPreset.id` from `tools/adjust.ts`; carries the grayscale/sepia
   * terms that have no slider. */
  preset: string;
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
  rotation?: number;
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
  rotation?: number;
}

/** How an arrow's *head* is drawn. `"none"` leaves the shaft bare, which is
 * what the Line tool produces -- so a line is an arrow that hasn't grown a
 * head yet, and the style dropdown converts between them without redrawing.
 *
 * The shaft's weight is separate (`banner`), because the two are independent:
 * a tapered banner can carry any of these heads. */
export type ArrowStyle = "none" | "single" | "double" | "open" | "tail";

export interface ArrowShape extends ShapeBase {
  kind: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  /** Optional so arrows drawn before the extra styles existed stay valid;
   * `undefined` renders as `"single"`. */
  style?: ArrowStyle;
  /** Draws the shaft as a solid tapered banner instead of a stroked line.
   * Independent of `style`, so a banner can still carry any head. */
  banner?: boolean;
  /** Quadratic control point. Present only on curved arrows -- absent means
   * a straight shaft, which is what the `mid` handle clears back to. */
  curve?: ImgPoint;
}

export interface FreehandShape extends ShapeBase {
  kind: "freehand";
  points: ImgPoint[];
  stroke: string;
  strokeWidth: number;
}

export type TextAlign = "left" | "center" | "right";

export interface TextShape extends ShapeBase {
  kind: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  /** Legacy on/off background pill. Superseded by `bgColor`, which wins when
   * set; kept so text drawn before the color existed still renders its pill. */
  background: boolean;
  /** Optional so text drawn before formatting existed stays valid. Unset
   * `bold` keeps the original weight-600 look rather than dropping to 400. */
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
  /** Explicit background fill; `null` means no background. */
  bgColor?: string | null;
  rotation?: number;
}

export interface HighlightShape extends ShapeBase {
  kind: "highlight";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  rotation?: number;
}

/** How a censor region obscures what's underneath it. */
export type CensorMode = "pixelate" | "blur" | "solid";

export interface PixelateShape extends ShapeBase {
  kind: "pixelate";
  x: number;
  y: number;
  w: number;
  h: number;
  blockSize: number;
  /** Optional so shapes drawn before the blur/solid modes existed (and the
   * history snapshots holding them) stay valid; `undefined` is pixelate. */
  mode?: CensorMode;
  /** Fill for `mode: "solid"`; ignored by the other modes. */
  color?: string;
  rotation?: number;
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

/** An emoji badge placed with a click. `x`/`y` is its center, so resizing
 * from any handle keeps it visually anchored where it was dropped. */
export interface StampShape extends ShapeBase {
  kind: "stamp";
  x: number;
  y: number;
  size: number;
  emoji: string;
  rotation?: number;
}

/** A circular magnifier over the underlying image -- a callout that shows
 * detail in place rather than obscuring it. */
export interface LoupeShape extends ShapeBase {
  kind: "loupe";
  /** Center of the lens. */
  x: number;
  y: number;
  r: number;
  factor: number;
  stroke: string;
  strokeWidth: number;
}

export interface ImageShape extends ShapeBase {
  kind: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
  rotation?: number;
}

export type Shape =
  | RectShape
  | EllipseShape
  | ArrowShape
  | FreehandShape
  | TextShape
  | HighlightShape
  | PixelateShape
  | SpotlightShape
  | ImageShape
  | MarkerShape
  | StampShape
  | LoupeShape;

export function shapeBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case "rect":
    case "ellipse":
    case "highlight":
    case "pixelate":
    case "spotlight":
    case "image":
      return { x: s.x, y: s.y, w: s.w, h: s.h };
    case "arrow": {
      // A curved arrow can bow well outside its endpoints' box, so the
      // control point joins the extent -- otherwise hit-testing and the
      // selection outline would both miss the visible middle of the curve.
      const xs = [s.x1, s.x2];
      const ys = [s.y1, s.y2];
      if (s.curve) {
        xs.push(s.curve.x);
        ys.push(s.curve.y);
      }
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
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
    case "stamp":
      return { x: s.x - s.size / 2, y: s.y - s.size / 2, w: s.size, h: s.size };
    case "loupe":
      return { x: s.x - s.r, y: s.y - s.r, w: s.r * 2, h: s.r * 2 };
  }
}

/** 8 resize-handle positions (image-space) for a rect-like bounding box. */
export type RectHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
/** Shape kinds that can carry a `rotation`. Arrows, lines and freehand are
 * absent: their geometry already expresses orientation, so a second way to
 * turn them would only be ambiguous. */
export type RotatableShape =
  | RectShape
  | EllipseShape
  | HighlightShape
  | PixelateShape
  | ImageShape
  | TextShape
  | StampShape;

const ROTATABLE_KINDS = new Set<Shape["kind"]>([
  "rect",
  "ellipse",
  "highlight",
  "pixelate",
  "image",
  "text",
  "stamp",
]);

export function isRotatable(s: Shape): s is RotatableShape {
  return ROTATABLE_KINDS.has(s.kind);
}

/** Degrees a shape is turned by, 0 when it does not rotate at all. */
export function rotationOf(s: Shape): number {
  return isRotatable(s) ? (s.rotation ?? 0) : 0;
}

/** Center a rotation turns about: the middle of the shape's unrotated box. */
export function rotationCenter(s: Shape): ImgPoint {
  const b = shapeBounds(s);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Rotates `p` by `degrees` about `origin`. */
export function rotatePoint(p: ImgPoint, origin: ImgPoint, degrees: number): ImgPoint {
  if (degrees === 0) return p;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

/** Maps a pointer position into a rotated shape's own unrotated frame, so
 * hit-testing and resize math can keep working in axis-aligned coordinates. */
export function toLocalPoint(p: ImgPoint, s: Shape): ImgPoint {
  const rotation = rotationOf(s);
  return rotation === 0 ? p : rotatePoint(p, rotationCenter(s), -rotation);
}

/** Axis-aligned box that contains the shape *as drawn*, i.e. after rotation.
 * Used by snapping, which compares shapes against each other on screen. */
export function rotatedBounds(s: Shape): { x: number; y: number; w: number; h: number } {
  const b = shapeBounds(s);
  const rotation = rotationOf(s);
  if (rotation === 0) return b;
  const center = rotationCenter(s);
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ].map((c) => rotatePoint(c, center, rotation));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
/** `mid` is the curved arrow's control point -- dragging it bends the shaft,
 * double-clicking it straightens the arrow again. */
export type EndpointHandleId = "start" | "end" | "mid";
/** The floating handle above a shape that turns it. */
export type RotateHandleId = "rotate";
export type HandleId = RectHandleId | EndpointHandleId | RotateHandleId;

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
export type EndpointShape = ArrowShape;

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
  return s.kind === "arrow";
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
  if (s.kind === "arrow") {
    const handles: Handle[] = [
      { id: "start", x: s.x1, y: s.y1 },
      { id: "end", x: s.x2, y: s.y2 },
    ];
    // Arrows get a third handle at the shaft's midpoint (or at the existing
    // control point) for bending them. A banner shaft is excluded: it is a
    // straight tapered polygon, so offering the handle would silently drop it
    // back to a stroked shaft when dragged.
    if (s.kind === "arrow" && s.banner !== true) {
      handles.push(
        s.curve
          ? { id: "mid", x: s.curve.x, y: s.curve.y }
          : { id: "mid", x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 },
      );
    }
    return handles;
  }
  // Stamps and loupes are centered rather than corner-anchored, so they are
  // not `RectLikeShape`, but they still resize from a bounding box.
  const boxed = isRectLike(s) || s.kind === "stamp" || s.kind === "loupe";
  if (!boxed && !isRotatable(s)) return [];

  const bounds = shapeBounds(s);
  // Text has no resize handles -- its size is the font-size slider, and a
  // drag-resized text box would have to reflow rather than scale -- but it
  // still gets the rotate handle.
  const handles = boxed ? rectHandles(bounds) : [];
  if (isRotatable(s)) handles.push(rotateHandle(bounds));

  // Positions are reported as drawn, so a rotated shape's handles ride
  // around with it and stay under the corners the user can see.
  const rotation = rotationOf(s);
  if (rotation === 0) return handles;
  const center = rotationCenter(s);
  return handles.map((h) => ({ ...h, ...rotatePoint(h, center, rotation) }));
}

/** Distance the rotate handle floats above the shape's top edge. */
export const ROTATE_HANDLE_OFFSET = 24;

function rotateHandle(b: { x: number; y: number; w: number; h: number }): Handle {
  return { id: "rotate", x: b.x + b.w / 2, y: b.y - ROTATE_HANDLE_OFFSET };
}

export function hitTest(s: Shape, p: ImgPoint, pad = 6): boolean {
  const b = shapeBounds(s);
  // Rotated shapes are tested in their own frame: the pointer is turned back
  // by the shape's rotation, so the comparison stays a plain box check.
  const local = toLocalPoint(p, s);
  return local.x >= b.x - pad && local.x <= b.x + b.w + pad && local.y >= b.y - pad && local.y <= b.y + b.h + pad;
}
