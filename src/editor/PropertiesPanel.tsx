import { Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { ColorPicker } from "../ui/ColorPicker";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import type { Backdrop, MeasureLine, Shape, SpotlightForm, Style, ToolId } from "./types";
import { measurementLabel } from "../lib/color";
import { BACKDROP_PRESETS, presetCss } from "./tools/backdrop";

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
}

const SHOWS_STROKE_WIDTH: ToolId[] = ["rect", "ellipse", "arrow", "line", "freehand"];
const SHOWS_COLOR: ToolId[] = ["rect", "ellipse", "arrow", "line", "freehand", "text", "highlight", "marker"];
const SHOWS_FILL: ToolId[] = ["rect", "ellipse"];
const SHOWS_FONT_SIZE: ToolId[] = ["text"];
const SHOWS_BLOCK_SIZE: ToolId[] = ["pixelate"];
const SHOWS_MARKER_SIZE: ToolId[] = ["marker"];
const SHOWS_SPOTLIGHT_DIM: ToolId[] = ["spotlight"];
/** Ellipse is deliberately absent -- it has no corners to round. Spotlight
 * qualifies only in its rect form, which `showRadius` checks separately. */
const SHOWS_RADIUS: ToolId[] = ["rect", "spotlight"];

const SPOTLIGHT_FORMS: { value: SpotlightForm; label: string }[] = [
  { value: "rect", label: "Rectangle" },
  { value: "ellipse", label: "Circle" },
];

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
              min={1}
              max={20}
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
                min={0}
                max={100}
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
    case "line":
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
              min={1}
              max={20}
              onChange={(strokeWidth) => {
                onUpdateShape({ ...shape, strokeWidth });
                onChange({ strokeWidth });
              }}
            />
          </Field>
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
              min={10}
              max={72}
              onChange={(fontSize) => {
                onUpdateShape({ ...shape, fontSize });
                onChange({ fontSize });
              }}
            />
          </Field>
          <Field label="Background">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">Background pill</span>
              <Switch
                aria-label="Background pill"
                checked={shape.background}
                onChange={(background) => onUpdateShape({ ...shape, background })}
              />
            </div>
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
    case "pixelate":
      return (
        <Field label="Block size">
          <Slider
            aria-label="Pixelate block size"
            value={shape.blockSize}
            min={4}
            max={40}
            onChange={(blockSize) => {
              onUpdateShape({ ...shape, blockSize });
              onChange({ pixelateBlock: blockSize });
            }}
          />
        </Field>
      );
    case "spotlight":
      return (
        <>
          <Field label="Shape">
            <Segmented
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
              min={10}
              max={90}
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
                min={0}
                max={100}
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
              min={8}
              max={40}
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
}: PropertiesPanelProps) {
  if (selectedShape) {
    return (
      <div className="w-52 border-l border-[var(--border)] bg-[var(--surface)] p-3 flex flex-col gap-4">
        <SelectedShapeFields shape={selectedShape} onUpdateShape={onUpdateShape} onChange={onChange} />
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
            min={10}
            max={90}
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
            min={1}
            max={20}
            onChange={(strokeWidth) => onChange({ strokeWidth })}
          />
        </Field>
      )}
      {showRadius && (
        <Field label="Corner radius">
          <Slider
            aria-label="Corner radius"
            value={style.radius}
            min={0}
            max={100}
            onChange={(radius) => onChange({ radius })}
          />
        </Field>
      )}
      {showFont && (
        <Field label="Font size">
          <Slider
            aria-label="Font size"
            value={style.fontSize}
            min={10}
            max={72}
            onChange={(fontSize) => onChange({ fontSize })}
          />
        </Field>
      )}
      {showBlock && (
        <Field label="Block size">
          <Slider
            aria-label="Pixelate block size"
            value={style.pixelateBlock}
            min={4}
            max={40}
            onChange={(pixelateBlock) => onChange({ pixelateBlock })}
          />
        </Field>
      )}
      {showMarkerSize && (
        <Field label="Marker size">
          <Slider
            aria-label="Marker size"
            value={style.markerSize}
            min={8}
            max={40}
            onChange={(markerSize) => onChange({ markerSize })}
          />
        </Field>
      )}
    </div>
  );
}
