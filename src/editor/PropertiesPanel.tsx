import { useState } from "react";
import { Bold, Italic, Trash2, Underline } from "lucide-react";
import { Button } from "../ui/Button";
import { ColorPicker } from "../ui/ColorPicker";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import { Select } from "../ui/Select";
import { StampPicker } from "../ui/StampPicker";
import type {
  Adjustments,
  ArrowStyle,
  Backdrop,
  TextShape,
  MeasureLine,
  Shape,
  Style,
  ToolId,
} from "./types";
import { isRotatable } from "./types";
import { measurementLabel } from "../lib/color";
import { ADJUST_PRESETS, IDENTITY_ADJUSTMENTS } from "./tools/adjust";
import { BACKDROP_PRESETS, presetCss } from "./tools/backdrop";
import { ARROW_STYLES, CENSOR_MODES, RANGES, SPOTLIGHT_FORMS, TEXT_ALIGNMENTS } from "./tools/labels";

interface PropertiesPanelProps {
  tool: ToolId;
  style: Style;
  onChange: (partial: Partial<Style>) => void;
  selectedShape: Shape | null;
  onUpdateShape: (shape: Shape) => void;
  onDeleteShape: () => void;
  backdrop: Backdrop;
  onBackdropChange: (partial: Partial<Backdrop>) => void;
  measureLine: MeasureLine | null;
  onCopyMeasurement: () => void;
  adjustments: Adjustments;
  onAdjustmentsChange: (partial: Partial<Adjustments>) => void;
  onFlip: (axis: "h" | "v") => void;
  /** Source dimensions the Resize field measures against. */
  imageWidth: number;
  imageHeight: number;
  resize: { w: number; h: number } | null;
  onResizeChange: (size: { w: number; h: number } | null) => void;
  /** Whether Adjust or Backdrop currently owns the panel (toolbar toggles). */
  adjustOpen: boolean;
  backdropOpen: boolean;
  snapToText: boolean;
  onSnapToTextChange: (next: boolean) => void;
  /** Dims the snap toggle when no OCR engine is available to snap with. */
  ocrUnavailable: boolean;
}

const SHOWS_STROKE_WIDTH: ToolId[] = ["rect", "ellipse", "arrow", "line", "freehand"];
const SHOWS_COLOR: ToolId[] = ["rect", "ellipse", "arrow", "line", "freehand", "text", "highlight", "marker"];
const SHOWS_FILL: ToolId[] = ["rect", "ellipse"];
const SHOWS_FONT_SIZE: ToolId[] = ["text"];
const SHOWS_BLOCK_SIZE: ToolId[] = ["pixelate"];
const SHOWS_MARKER_SIZE: ToolId[] = ["marker", "stamp"];
const SHOWS_SPOTLIGHT_DIM: ToolId[] = ["spotlight"];
/** Ellipse is deliberately absent -- it has no corners to round. Spotlight
 * qualifies only in its rect form, which `showRadius` checks separately. */
const SHOWS_RADIUS: ToolId[] = ["rect", "spotlight"];




/** Stored rotation (0..359) as a signed angle (-180..180), so the slider can
 * put the 0 default at the centre of its track. */
function signedRotation(rotation: number): number {
  return rotation > 180 ? rotation - 360 : rotation;
}

/** Inverse of `signedRotation`: back into the 0..359 the shape stores. */
function normalizeRotation(degrees: number): number {
  return ((Math.round(degrees) % 360) + 360) % 360;
}

/** Effective background for a text shape: the explicit `bgColor` when set,
 * otherwise the legacy on/off pill's implicit black, otherwise none. */
function textBackgroundColor(shape: TextShape): string | null {
  if (shape.bgColor !== undefined) return shape.bgColor;
  return shape.background ? "#000000" : null;
}

/** A small square toggle for the bold/italic/underline trio -- they read as
 * one control group, which a stack of labelled Switch rows would not. */
function FormatToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center h-9 rounded-[var(--radius-sm)] border ${
        active
          ? "bg-[var(--accent)] text-white border-[var(--accent)]"
          : "bg-[var(--surface)] text-[var(--fg)] border-[var(--border)] hover:bg-[var(--surface-hover)]"
      }`}
    >
      {children}
    </button>
  );
}


/** Output dimensions for the saved image. Lives with the adjustments rather
 * than in the status bar because it is another property of the exported
 * file, not of the view. */
function ResizeFields({
  imageWidth,
  imageHeight,
  resize,
  onResizeChange,
}: {
  imageWidth: number;
  imageHeight: number;
  resize: { w: number; h: number } | null;
  onResizeChange: (size: { w: number; h: number } | null) => void;
}) {
  const w = resize?.w ?? imageWidth;
  const h = resize?.h ?? imageHeight;
  const aspect = imageHeight === 0 ? 1 : imageWidth / imageHeight;
  const [linked, setLinked] = useState(true);
  // Held while typing so a half-entered number ("8" on the way to "800")
  // isn't committed and immediately reflected back as a resize.
  const [draft, setDraft] = useState<{ w: string; h: string } | null>(null);

  function commit(next: { w: number; h: number }) {
    setDraft(null);
    const clamped = { w: Math.max(1, Math.round(next.w)), h: Math.max(1, Math.round(next.h)) };
    // Matching the source size means "no resize", so the export path can
    // skip the resample entirely.
    onResizeChange(clamped.w === imageWidth && clamped.h === imageHeight ? null : clamped);
  }

  function commitAxis(axis: "w" | "h") {
    const raw = axis === "w" ? draft?.w : draft?.h;
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      setDraft(null);
      return;
    }
    if (!linked) {
      commit(axis === "w" ? { w: value, h } : { w, h: value });
      return;
    }
    commit(axis === "w" ? { w: value, h: value / aspect } : { w: value * aspect, h: value });
  }

  const inputClass =
    "w-full min-w-0 h-8 px-2 rounded-[var(--radius-sm)] bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--fg)] outline-none focus:border-[var(--accent)]";
  const percent = imageWidth === 0 ? 100 : Math.round((w / imageWidth) * 100);

  return (
    <Field label="Resize">
      <div className="flex items-center gap-1.5">
        <input
          aria-label="Export width"
          inputMode="numeric"
          className={inputClass}
          value={draft ? draft.w : String(w)}
          onChange={(e) => setDraft({ w: e.target.value, h: draft?.h ?? String(h) })}
          onBlur={() => commitAxis("w")}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitAxis("w");
            if (e.key === "Escape") setDraft(null);
          }}
        />
        <span className="text-xs text-[var(--fg-muted)]">×</span>
        <input
          aria-label="Export height"
          inputMode="numeric"
          className={inputClass}
          value={draft ? draft.h : String(h)}
          onChange={(e) => setDraft({ w: draft?.w ?? String(w), h: e.target.value })}
          onBlur={() => commitAxis("h")}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitAxis("h");
            if (e.key === "Escape") setDraft(null);
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--fg)]">Lock aspect</span>
        <Switch aria-label="Lock aspect ratio" checked={linked} onChange={setLinked} />
      </div>
      <div className="flex items-center gap-1">
        {[100, 75, 50, 33].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => commit({ w: (imageWidth * p) / 100, h: (imageHeight * p) / 100 })}
            className={`flex-1 h-7 rounded-[var(--radius-sm)] text-[11px] font-medium ${
              percent === p
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--surface-hover)] text-[var(--fg)] hover:brightness-95"
            }`}
          >
            {p}%
          </button>
        ))}
      </div>
      <span className="text-xs text-[var(--fg-muted)]">
        {resize ? `Saves at ${w} × ${h}, from ${imageWidth} × ${imageHeight}` : "Saves at its own size"}
      </span>
    </Field>
  );
}

function AdjustFields({
  adjustments,
  onAdjustmentsChange,
  onFlip,
  imageWidth,
  imageHeight,
  resize,
  onResizeChange,
}: {
  adjustments: Adjustments;
  onAdjustmentsChange: (partial: Partial<Adjustments>) => void;
  onFlip: (axis: "h" | "v") => void;
  imageWidth: number;
  imageHeight: number;
  resize: { w: number; h: number } | null;
  onResizeChange: (size: { w: number; h: number } | null) => void;
}) {
  // Moving a slider means the look is no longer exactly a named preset, but
  // its grayscale/sepia term should survive the tweak -- so only "original"
  // is cleared, and the tinted presets keep their identity.
  const withPreset = (partial: Partial<Adjustments>) =>
    onAdjustmentsChange({ ...partial, preset: adjustments.preset });

  return (
    <>
      <Field label="Preset">
        <div className="grid grid-cols-3 gap-1">
          {ADJUST_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={adjustments.preset === p.id}
              onClick={() => onAdjustmentsChange({ ...p.values, preset: p.id })}
              className={`h-7 rounded-[var(--radius-sm)] text-[11px] font-medium ${
                adjustments.preset === p.id
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-hover)] text-[var(--fg)] hover:brightness-95"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Brightness">
        <Slider
          aria-label="Brightness"
          value={adjustments.brightness}
          min={20}
          max={200}
          onChange={(brightness) => withPreset({ brightness })}
        />
      </Field>
      <Field label="Contrast">
        <Slider
          aria-label="Contrast"
          value={adjustments.contrast}
          min={20}
          max={200}
          onChange={(contrast) => withPreset({ contrast })}
        />
      </Field>
      <Field label="Saturation">
        <Slider
          aria-label="Saturation"
          value={adjustments.saturation}
          min={0}
          max={200}
          onChange={(saturation) => withPreset({ saturation })}
        />
      </Field>
      <Field label="Sharpness">
        <Slider
          aria-label="Sharpness"
          value={adjustments.sharpness}
          min={0}
          max={100}
          onChange={(sharpness) => withPreset({ sharpness })}
        />
      </Field>
      <Field label="Invert">
        <div className="flex items-center justify-between">
          <span className="text-sm text-[var(--fg)]">Invert colors</span>
          <Switch
            aria-label="Invert colors"
            checked={adjustments.invert}
            onChange={(invert) => withPreset({ invert })}
          />
        </div>
      </Field>
      <Field label="Flip">
        {/* Flips bake into the image and every annotation immediately, and
            reset undo -- same contract as confirming a crop. */}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => onFlip("h")}>
            Horizontal
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onFlip("v")}>
            Vertical
          </Button>
        </div>
      </Field>
      <ResizeFields
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        resize={resize}
        onResizeChange={onResizeChange}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          onAdjustmentsChange(IDENTITY_ADJUSTMENTS);
          onResizeChange(null);
        }}
      >
        Reset adjustments
      </Button>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-[var(--fg-muted)]">{label}</span>
      {children}
    </div>
  );
}

/** Edits the currently-selected shape's own fields directly, so switching a
 * color/width/etc. after the fact affects that shape -- not just the style
 * used for the *next* one drawn (which is what `style`/`onChange` control).
 * Each edit also mirrors into the default `style` via `onChange`, so the
 * next shape drawn inherits whatever was just picked here. */
function SelectedShapeFields({
  shape,
  onUpdateShape,
  onChange,
}: {
  shape: Shape;
  onUpdateShape: (shape: Shape) => void;
  onChange: (partial: Partial<Style>) => void;
}) {
  switch (shape.kind) {
    case "rect":
    case "ellipse":
      return (
        <>
          <Field label="Color">
            <ColorPicker
              value={shape.stroke}
              onChange={(stroke) => {
                onUpdateShape({ ...shape, stroke });
                onChange({ stroke });
              }}
            />
          </Field>
          <Field label="Fill">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">Filled</span>
              <Switch
                aria-label="Filled"
                checked={shape.fill !== null}
                onChange={(filled) => {
                  const fill = filled ? shape.stroke : null;
                  onUpdateShape({ ...shape, fill });
                  onChange({ fill });
                }}
              />
            </div>
            {shape.fill !== null && (
              <ColorPicker
                value={shape.fill}
                onChange={(fill) => {
                  onUpdateShape({ ...shape, fill });
                  onChange({ fill });
                }}
              />
            )}
          </Field>
          <Field label="Stroke width">
            <Slider
              aria-label="Stroke width"
              value={shape.strokeWidth}
              {...RANGES.strokeWidth}
              onChange={(strokeWidth) => {
                onUpdateShape({ ...shape, strokeWidth });
                onChange({ strokeWidth });
              }}
            />
          </Field>
          {/* Rect only -- an ellipse has no corners to round. */}
          {shape.kind === "rect" && (
            <Field label="Corner radius">
              <Slider
                aria-label="Corner radius"
                value={shape.radius ?? 0}
                {...RANGES.cornerRadius}
                onChange={(radius) => {
                  onUpdateShape({ ...shape, radius });
                  onChange({ radius });
                }}
              />
            </Field>
          )}
        </>
      );
    case "arrow":
    case "freehand":
      return (
        <>
          <Field label="Color">
            <ColorPicker
              value={shape.stroke}
              onChange={(stroke) => {
                onUpdateShape({ ...shape, stroke });
                onChange({ stroke });
              }}
            />
          </Field>
          <Field label="Stroke width">
            <Slider
              aria-label="Stroke width"
              value={shape.strokeWidth}
              {...RANGES.strokeWidth}
              onChange={(strokeWidth) => {
                onUpdateShape({ ...shape, strokeWidth });
                onChange({ strokeWidth });
              }}
            />
          </Field>
          {shape.kind === "arrow" && (
            <>
              <Field label="Arrow head">
                <Select
                  aria-label="Arrow head"
                  value={shape.style ?? "single"}
                  options={ARROW_STYLES}
                  onChange={(next) => {
                    const arrowStyle = next as ArrowStyle;
                    onUpdateShape({ ...shape, style: arrowStyle });
                    onChange({ arrowStyle });
                  }}
                />
              </Field>
              <Field label="Shaft">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--fg)]">Thick banner</span>
                  <Switch
                    aria-label="Thick banner"
                    checked={shape.banner === true}
                    onChange={(arrowBanner) => {
                      // A banner shaft cannot follow a curve, so turning it on
                      // straightens the arrow rather than silently ignoring
                      // the bend.
                      onUpdateShape({
                        ...shape,
                        banner: arrowBanner,
                        curve: arrowBanner ? undefined : shape.curve,
                      });
                      onChange({ arrowBanner });
                    }}
                  />
                </div>
              </Field>
            </>
          )}
        </>
      );
    case "text":
      return (
        <>
          <Field label="Color">
            <ColorPicker
              value={shape.color}
              onChange={(color) => {
                onUpdateShape({ ...shape, color });
                onChange({ stroke: color });
              }}
            />
          </Field>
          <Field label="Font size">
            <Slider
              aria-label="Font size"
              value={shape.fontSize}
              {...RANGES.fontSize}
              onChange={(fontSize) => {
                onUpdateShape({ ...shape, fontSize });
                onChange({ fontSize });
              }}
            />
          </Field>
          <Field label="Format">
            <div className="flex items-center gap-1">
              <FormatToggle
                label="Bold"
                active={shape.bold ?? false}
                onClick={() => {
                  const textBold = !(shape.bold ?? false);
                  onUpdateShape({ ...shape, bold: textBold });
                  onChange({ textBold });
                }}
              >
                <Bold size={16} />
              </FormatToggle>
              <FormatToggle
                label="Italic"
                active={shape.italic ?? false}
                onClick={() => {
                  const textItalic = !(shape.italic ?? false);
                  onUpdateShape({ ...shape, italic: textItalic });
                  onChange({ textItalic });
                }}
              >
                <Italic size={16} />
              </FormatToggle>
              <FormatToggle
                label="Underline"
                active={shape.underline ?? false}
                onClick={() => {
                  const textUnderline = !(shape.underline ?? false);
                  onUpdateShape({ ...shape, underline: textUnderline });
                  onChange({ textUnderline });
                }}
              >
                <Underline size={16} />
              </FormatToggle>
            </div>
          </Field>
          <Field label="Alignment">
            <Segmented
              fullWidth
              aria-label="Text alignment"
              size="sm"
              value={shape.align ?? "left"}
              options={TEXT_ALIGNMENTS}
              onChange={(textAlign) => {
                onUpdateShape({ ...shape, align: textAlign });
                onChange({ textAlign });
              }}
            />
          </Field>
          <Field label="Background">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">Background</span>
              <Switch
                aria-label="Text background"
                checked={textBackgroundColor(shape) !== null}
                onChange={(on) => {
                  const bgColor = on ? "#000000" : null;
                  // `background` is cleared alongside so the legacy pill
                  // can't linger under an explicit "no background".
                  onUpdateShape({ ...shape, bgColor, background: false });
                  onChange({ textBgColor: bgColor });
                }}
              />
            </div>
            {textBackgroundColor(shape) !== null && (
              <ColorPicker
                aria-label="Text background color"
                value={textBackgroundColor(shape) ?? "#000000"}
                onChange={(bgColor) => {
                  onUpdateShape({ ...shape, bgColor, background: false });
                  onChange({ textBgColor: bgColor });
                }}
              />
            )}
          </Field>
        </>
      );
    case "stamp":
      return (
        <>
          <Field label="Emoji">
            <StampPicker
              value={shape.emoji}
              onChange={(emoji) => {
                onUpdateShape({ ...shape, emoji });
                onChange({ stampEmoji: emoji });
              }}
            />
          </Field>
          <Field label="Size">
            <Slider
              aria-label="Stamp size"
              value={shape.size}
              {...RANGES.stampSize}
              onChange={(size) => onUpdateShape({ ...shape, size })}
            />
          </Field>
        </>
      );
    case "loupe":
      return (
        <>
          <Field label="Color">
            <ColorPicker
              value={shape.stroke}
              onChange={(stroke) => {
                onUpdateShape({ ...shape, stroke });
                onChange({ stroke });
              }}
            />
          </Field>
          <Field label="Magnification">
            <Slider
              aria-label="Magnification"
              value={shape.factor}
              {...RANGES.loupeFactor}
              onChange={(factor) => {
                onUpdateShape({ ...shape, factor });
                onChange({ loupeFactor: factor });
              }}
            />
          </Field>
          <Field label="Ring width">
            <Slider
              aria-label="Ring width"
              value={shape.strokeWidth}
              {...RANGES.strokeWidth}
              onChange={(strokeWidth) => {
                onUpdateShape({ ...shape, strokeWidth });
                onChange({ strokeWidth });
              }}
            />
          </Field>
        </>
      );
    case "highlight":
      return (
        <Field label="Color">
          <ColorPicker
            value={shape.color}
            onChange={(color) => {
              onUpdateShape({ ...shape, color });
              onChange({ stroke: color });
            }}
          />
        </Field>
      );
    case "pixelate": {
      const mode = shape.mode ?? "pixelate";
      return (
        <>
          <Field label="Censor with">
            <Segmented
              fullWidth
              aria-label="Censor mode"
              size="sm"
              value={mode}
              options={CENSOR_MODES}
              onChange={(next) => {
                onUpdateShape({ ...shape, mode: next });
                onChange({ censorMode: next });
              }}
            />
          </Field>
          {mode === "solid" ? (
            <Field label="Color">
              <ColorPicker
                aria-label="Censor color"
                value={shape.color ?? "#000000"}
                onChange={(color) => {
                  onUpdateShape({ ...shape, color });
                  onChange({ censorColor: color });
                }}
              />
            </Field>
          ) : (
            <Field label={mode === "blur" ? "Blur amount" : "Block size"}>
              <Slider
                aria-label={mode === "blur" ? "Blur amount" : "Pixelate block size"}
                value={shape.blockSize}
                {...RANGES.censorAmount}
                onChange={(blockSize) => {
                  onUpdateShape({ ...shape, blockSize });
                  onChange({ pixelateBlock: blockSize });
                }}
              />
            </Field>
          )}
        </>
      );
    }
    case "spotlight":
      return (
        <>
          <Field label="Shape">
            <Segmented
              fullWidth
              aria-label="Spotlight shape"
              size="sm"
              value={shape.form}
              options={SPOTLIGHT_FORMS}
              onChange={(form) => {
                onUpdateShape({ ...shape, form });
                onChange({ spotlightForm: form });
              }}
            />
          </Field>
          <Field label="Dim outside">
            <Slider
              aria-label="Spotlight dim"
              value={Math.round(shape.dimOpacity * 100)}
              {...RANGES.spotlightDim}
              onChange={(percent) => {
                onUpdateShape({ ...shape, dimOpacity: percent / 100 });
                onChange({ spotlightDim: percent / 100 });
              }}
            />
          </Field>
          {/* Rect form only -- the ellipse form is already fully round. */}
          {shape.form === "rect" && (
            <Field label="Corner radius">
              <Slider
                aria-label="Corner radius"
                value={shape.radius ?? 0}
                {...RANGES.cornerRadius}
                onChange={(radius) => {
                  onUpdateShape({ ...shape, radius });
                  onChange({ radius });
                }}
              />
            </Field>
          )}
        </>
      );
    case "image":
      // Position and size are edited on the canvas; nothing else to tweak.
      return null;
    case "marker":
      return (
        <>
          <Field label="Color">
            <ColorPicker
              value={shape.color}
              onChange={(color) => {
                onUpdateShape({ ...shape, color });
                onChange({ stroke: color });
              }}
            />
          </Field>
          <Field label="Marker size">
            <Slider
              aria-label="Marker size"
              value={shape.radius}
              {...RANGES.markerSize}
              onChange={(radius) => {
                onUpdateShape({ ...shape, radius });
                onChange({ markerSize: radius });
              }}
            />
          </Field>
        </>
      );
  }
}

function BackdropFields({
  backdrop,
  onBackdropChange,
}: {
  backdrop: Backdrop;
  onBackdropChange: (partial: Partial<Backdrop>) => void;
}) {
  return (
    <>
      <Field label="Backdrop">
        <div className="flex flex-wrap gap-1.5">
          {BACKDROP_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-label={preset.label}
              aria-pressed={backdrop.preset === preset.id}
              onClick={() => onBackdropChange({ preset: preset.id })}
              className="w-8 h-8 rounded-[var(--radius-sm)] border focus-visible:shadow-[var(--focus-ring)]"
              style={{
                background: presetCss(preset.id),
                borderColor: backdrop.preset === preset.id ? "var(--accent)" : "var(--border)",
                borderWidth: backdrop.preset === preset.id ? 2 : 1,
              }}
            />
          ))}
        </div>
      </Field>
      <Field label="Padding">
        <Slider
          aria-label="Backdrop padding"
          value={backdrop.padding}
          min={0}
          max={200}
          onChange={(padding) => onBackdropChange({ padding })}
        />
      </Field>
      <Field label="Corner radius">
        <Slider
          aria-label="Backdrop corner radius"
          value={backdrop.cornerRadius}
          min={0}
          max={64}
          onChange={(cornerRadius) => onBackdropChange({ cornerRadius })}
        />
      </Field>
      <Field label="Shadow">
        <div className="flex items-center justify-between">
          <span className="text-sm text-[var(--fg)]">Drop shadow</span>
          <Switch
            aria-label="Drop shadow"
            checked={backdrop.shadow}
            onChange={(shadow) => onBackdropChange({ shadow })}
          />
        </div>
      </Field>
    </>
  );
}

export function PropertiesPanel({
  tool,
  style,
  onChange,
  selectedShape,
  onUpdateShape,
  onDeleteShape,
  backdrop,
  onBackdropChange,
  measureLine,
  onCopyMeasurement,
  adjustments,
  onAdjustmentsChange,
  onFlip,
  adjustOpen,
  backdropOpen,
  snapToText,
  onSnapToTextChange,
  ocrUnavailable,
  imageWidth,
  imageHeight,
  resize,
  onResizeChange,
}: PropertiesPanelProps) {
  // Backdrop and Adjust each own the whole panel while open. Stacking either
  // under the active tool's own settings made the two read as one set of
  // controls, so a tool's colour or size looked like part of the frame.
  if (backdropOpen && backdrop.enabled) {
    return (
      <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-4 overflow-y-auto">
        <BackdropFields backdrop={backdrop} onBackdropChange={onBackdropChange} />
      </div>
    );
  }

  if (adjustOpen) {
    return (
      <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-4 overflow-y-auto">
        <AdjustFields
          adjustments={adjustments}
          onAdjustmentsChange={onAdjustmentsChange}
          onFlip={onFlip}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          resize={resize}
          onResizeChange={onResizeChange}
        />
      </div>
    );
  }

  if (selectedShape) {
    return (
      <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-4 overflow-y-auto">
        <SelectedShapeFields shape={selectedShape} onUpdateShape={onUpdateShape} onChange={onChange} />
        {/* Shared across every rotatable kind, so it lives here rather than
            being repeated in each branch of SelectedShapeFields. */}
        {isRotatable(selectedShape) && (
          <Field label="Rotation">
            <Slider
              aria-label="Rotation"
              // Presented as -180..180 so the untouched default sits at the
              // middle of the track and either direction is an equal pull
              // from it. Stored as 0..359, which is what the render
              // transform and the mirror maths work in.
              value={signedRotation(selectedShape.rotation ?? 0)}
              {...RANGES.rotation}
              onChange={(degrees) =>
                onUpdateShape({ ...selectedShape, rotation: normalizeRotation(degrees) })
              }
            />
          </Field>
        )}
        <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={onDeleteShape}>
          Delete
        </Button>
      </div>
    );
  }

  const showColor = SHOWS_COLOR.includes(tool);
  const showFill = SHOWS_FILL.includes(tool);
  const showStroke = SHOWS_STROKE_WIDTH.includes(tool);
  const showFont = SHOWS_FONT_SIZE.includes(tool);
  const showBlock = SHOWS_BLOCK_SIZE.includes(tool);
  const showMarkerSize = SHOWS_MARKER_SIZE.includes(tool);
  const showSpotlightDim = SHOWS_SPOTLIGHT_DIM.includes(tool);
  const showRadius =
    SHOWS_RADIUS.includes(tool) && (tool !== "spotlight" || style.spotlightForm === "rect");

  if (tool === "measure") {
    return (
      <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-3">
        <Field label="Measurement">
          {measureLine ? (
            <span className="text-sm font-mono text-[var(--fg)]">
              {measurementLabel(measureLine.start, measureLine.end)}
            </span>
          ) : (
            <span className="text-xs text-[var(--fg-muted)]">Drag on the image to measure. Hold Shift to lock the axis.</span>
          )}
        </Field>
        {measureLine && (
          <Button size="sm" variant="secondary" onClick={onCopyMeasurement}>
            Copy measurement
          </Button>
        )}
      </div>
    );
  }

  if (
    !showColor &&
    !showFill &&
    !showStroke &&
    !showFont &&
    !showBlock &&
    !showMarkerSize &&
    !showSpotlightDim &&
    !showRadius &&
    // The loupe's magnification slider is its own tool-level field rather
    // than one of the shared SHOWS_* groups, so it needs naming here or the
    // panel would claim the tool has no options.
    tool !== "loupe" &&
    !backdrop.enabled
  ) {
    return (
      <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3">
        <p className="text-xs text-[var(--fg-muted)]">No options for this tool.</p>
      </div>
    );
  }

  return (
    <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-4 overflow-y-auto">
      {backdrop.enabled && <BackdropFields backdrop={backdrop} onBackdropChange={onBackdropChange} />}
      {showSpotlightDim && (
        <Field label="Shape">
          <Segmented
            fullWidth
            aria-label="Spotlight shape"
            size="sm"
            value={style.spotlightForm}
            options={SPOTLIGHT_FORMS}
            onChange={(spotlightForm) => onChange({ spotlightForm })}
          />
        </Field>
      )}
      {showSpotlightDim && (
        <Field label="Dim outside">
          <Slider
            aria-label="Spotlight dim"
            value={Math.round(style.spotlightDim * 100)}
            {...RANGES.spotlightDim}
            onChange={(percent) => onChange({ spotlightDim: percent / 100 })}
          />
        </Field>
      )}
      {showColor && (
        <Field label="Color">
          <ColorPicker value={style.stroke} onChange={(stroke) => onChange({ stroke })} />
        </Field>
      )}
      {showFill && (
        <Field label="Fill">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--fg)]">Filled</span>
            <Switch
              aria-label="Filled"
              checked={style.fill !== null}
              onChange={(filled) => onChange({ fill: filled ? style.stroke : null })}
            />
          </div>
          {style.fill !== null && (
            <ColorPicker value={style.fill} onChange={(fill) => onChange({ fill })} />
          )}
        </Field>
      )}
      {showStroke && (
        <Field label="Stroke width">
          <Slider
            aria-label="Stroke width"
            value={style.strokeWidth}
            {...RANGES.strokeWidth}
            onChange={(strokeWidth) => onChange({ strokeWidth })}
          />
        </Field>
      )}
      {showRadius && (
        <Field label="Corner radius">
          <Slider
            aria-label="Corner radius"
            value={style.radius}
            {...RANGES.cornerRadius}
            onChange={(radius) => onChange({ radius })}
          />
        </Field>
      )}
      {showFont && (
        <>
          <Field label="Font size">
            <Slider
              aria-label="Font size"
              value={style.fontSize}
              {...RANGES.fontSize}
              onChange={(fontSize) => onChange({ fontSize })}
            />
          </Field>
          <Field label="Format">
            <div className="flex items-center gap-1">
              <FormatToggle
                label="Bold"
                active={style.textBold}
                onClick={() => onChange({ textBold: !style.textBold })}
              >
                <Bold size={16} />
              </FormatToggle>
              <FormatToggle
                label="Italic"
                active={style.textItalic}
                onClick={() => onChange({ textItalic: !style.textItalic })}
              >
                <Italic size={16} />
              </FormatToggle>
              <FormatToggle
                label="Underline"
                active={style.textUnderline}
                onClick={() => onChange({ textUnderline: !style.textUnderline })}
              >
                <Underline size={16} />
              </FormatToggle>
            </div>
          </Field>
          <Field label="Alignment">
            <Segmented
              fullWidth
              aria-label="Text alignment"
              size="sm"
              value={style.textAlign}
              options={TEXT_ALIGNMENTS}
              onChange={(textAlign) => onChange({ textAlign })}
            />
          </Field>
          <Field label="Background">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">Background</span>
              <Switch
                aria-label="Text background"
                checked={style.textBgColor !== null}
                onChange={(on) => onChange({ textBgColor: on ? "#000000" : null })}
              />
            </div>
            {style.textBgColor !== null && (
              <ColorPicker
                aria-label="Text background color"
                value={style.textBgColor}
                onChange={(textBgColor) => onChange({ textBgColor })}
              />
            )}
          </Field>
        </>
      )}
      {tool === "highlight" && (
        <Field label="Text">
          <div className="flex items-center justify-between">
            <span className={`text-sm ${ocrUnavailable ? "text-[var(--fg-muted)]" : "text-[var(--fg)]"}`}>
              {ocrUnavailable ? "Snap to text (needs OCR)" : "Snap to text"}
            </span>
            <Switch
              aria-label="Snap highlights to text"
              checked={snapToText && !ocrUnavailable}
              disabled={ocrUnavailable}
              onChange={onSnapToTextChange}
            />
          </div>
        </Field>
      )}
      {tool === "stamp" && (
        <Field label="Emoji">
          <StampPicker value={style.stampEmoji} onChange={(stampEmoji) => onChange({ stampEmoji })} />
        </Field>
      )}
      {tool === "loupe" && (
        <Field label="Magnification">
          <Slider
            aria-label="Magnification"
            value={style.loupeFactor}
            {...RANGES.loupeFactor}
            onChange={(loupeFactor) => onChange({ loupeFactor })}
          />
        </Field>
      )}
      {(tool === "arrow" || tool === "line") && (
        <>
          <Field label="Arrow head">
            <Select
              aria-label="Arrow head"
              value={style.arrowStyle}
              options={ARROW_STYLES}
              onChange={(arrowStyle) => onChange({ arrowStyle })}
            />
          </Field>
          <Field label="Shaft">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">Thick banner</span>
              <Switch
                aria-label="Thick banner"
                checked={style.arrowBanner}
                onChange={(arrowBanner) => onChange({ arrowBanner })}
              />
            </div>
          </Field>
        </>
      )}
      {showBlock && (
        <>
          <Field label="Censor with">
            <Segmented
              fullWidth
              aria-label="Censor mode"
              size="sm"
              value={style.censorMode}
              options={CENSOR_MODES}
              onChange={(censorMode) => onChange({ censorMode })}
            />
          </Field>
          {style.censorMode === "solid" ? (
            <Field label="Color">
              <ColorPicker
                aria-label="Censor color"
                value={style.censorColor}
                onChange={(censorColor) => onChange({ censorColor })}
              />
            </Field>
          ) : (
            <Field label={style.censorMode === "blur" ? "Blur amount" : "Block size"}>
              <Slider
                aria-label={style.censorMode === "blur" ? "Blur amount" : "Pixelate block size"}
                value={style.pixelateBlock}
                {...RANGES.censorAmount}
                onChange={(pixelateBlock) => onChange({ pixelateBlock })}
              />
            </Field>
          )}
        </>
      )}
      {showMarkerSize && (
        <Field label="Marker size">
          <Slider
            aria-label="Marker size"
            value={style.markerSize}
            {...RANGES.markerSize}
            onChange={(markerSize) => onChange({ markerSize })}
          />
        </Field>
      )}
    </div>
  );
}
