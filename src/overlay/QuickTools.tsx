import { Popover as RadixPopover } from "radix-ui";
import { Bold, ChevronDown, Italic, Redo2, Trash2, Underline, Undo2 } from "lucide-react";
import { Button } from "../ui/Button";
import { ColorPicker } from "../ui/ColorPicker";
import { Segmented } from "../ui/Segmented";
import { StampPicker } from "../ui/StampPicker";
import { Select } from "../ui/Select";
import { Field } from "../ui/Field";
import { Slider } from "../ui/Slider";
import { Switch } from "../ui/Switch";
import {
  ARROW_STYLES,
  CENSOR_MODES,
  RANGES,
  SPOTLIGHT_FORMS,
  TEXT_ALIGNMENTS,
} from "../editor/tools/labels";
import { isRotatable, type Shape, type Style, type ToolId } from "../editor/types";

/** Stored rotation (0..359) shown as a signed angle, the same presentation
 * the editor's panel uses. */
function signedRotation(rotation: number): number {
  return rotation > 180 ? rotation - 360 : rotation;
}
import type { OverlayToolMeta } from "./tools";

/** Tools whose settings are colour and stroke width alone -- the shared
 * header covers them, so there is no per-tool section to add. */
const STROKE_ONLY: ToolId[] = ["freehand", "highlight"];

/** Style keys the shared header offers, per tool. A tool listed in neither
 * gets no colour swatch (a censor's colour is mode-specific, a stamp has no
 * stroke at all). */
const SHOWS_COLOR: ToolId[] = [
  "rect",
  "ellipse",
  "arrow",
  "line",
  "freehand",
  "text",
  "highlight",
  "marker",
  "loupe",
];
// Loupe is absent on purpose: the editor calls its stroke "Ring width" and
// gives it its own field, so this one mirrors that rather than showing the
// same control under two different names.
const SHOWS_STROKE_WIDTH: ToolId[] = ["rect", "ellipse", "arrow", "line", "freehand"];

/** Which of the bar's popovers is open. Owned by `Overlay.tsx` rather than
 * this component: Escape has to close a popover *before* it disarms the tool
 * or cancels the capture, and only the overlay's key handler knows that
 * order. */
export type QuickToolsPopover = "options" | "color";

interface QuickToolsProps {
  tools: OverlayToolMeta[];
  activeTool: ToolId | null;
  onSelectTool: (tool: ToolId | null) => void;
  /** The settings the dropdown edits: the selected shape's own values merged
   * over the session style, or just the session style when nothing is
   * selected. */
  style: Style;
  onStyleChange: (partial: Partial<Style>) => void;
  /** Which tool's option set the dropdown shows. Follows the selected shape
   * when there is one, so selecting a censor shows censor settings even
   * though the Select tool is what is armed. */
  optionsFor: ToolId | null;
  /** The shape under edit, or null. Drives the rotation control, which has no
   * `Style` equivalent -- it belongs to one shape, not to the next one drawn. */
  selectedShape: Shape | null;
  onRotate: (degrees: number) => void;
  /** Shown only while a shape is selected. */
  onDeleteSelected: (() => void) | null;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  openPopover: QuickToolsPopover | null;
  onOpenPopover: (popover: QuickToolsPopover | null) => void;
  left: number;
  top: number;
}

export function QuickTools({
  tools,
  activeTool,
  onSelectTool,
  style,
  onStyleChange,
  optionsFor,
  selectedShape,
  onRotate,
  onDeleteSelected,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  openPopover,
  onOpenPopover,
  left,
  top,
}: QuickToolsProps) {

  return (
    <div
      className="absolute z-40 flex items-center gap-0.5 p-1 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-md)] cursor-default"
      // The bar sits over the container's pointer surface; without this every
      // click on a tool would also read as a press on the overlay beneath and
      // start a fresh selection.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      style={{ left, top, transform: "translateX(-50%)" }}
    >
      {tools.map((t) => {
        const Icon = t.icon;
        const on = activeTool === t.id;
        return (
          <button
            key={t.id}
            type="button"
            aria-label={t.label}
            aria-pressed={on}
            title={t.label}
            // Clicking the armed tool disarms it, back to plain region
            // selection -- otherwise there is no way out but Escape.
            onClick={() => onSelectTool(on ? null : t.id)}
            className={`inline-flex items-center justify-center w-8 h-8 rounded-full ${
              on
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--fg)] hover:bg-[var(--surface-hover)]"
            }`}
          >
            <Icon size={16} />
          </button>
        );
      })}

      {optionsFor ? (
        <RadixPopover.Root
          // Stays mounted while the nested colour picker is open, which is a
          // second popover state -- collapsing to `=== "options"` would tear
          // this one down the instant the swatch was clicked, taking the
          // picker with it.
          open={openPopover !== null}
          onOpenChange={(o) => onOpenPopover(o ? "options" : null)}
        >
          <RadixPopover.Trigger asChild>
            <button
              type="button"
              aria-label="Tool settings"
              title="Settings"
              className={`inline-flex items-center justify-center w-6 h-8 rounded-full hover:bg-[var(--surface-hover)] ${
                openPopover === "options" ? "text-[var(--fg)]" : "text-[var(--fg-muted)]"
              }`}
            >
              <ChevronDown size={14} />
            </button>
          </RadixPopover.Trigger>
          {/* Portalled: an absolutely positioned menu inside this bar would
            * be clipped by it, which is how the editor toolbar's flyout came
            * out invisible. Radix also flips it when there is no room below,
            * which matters for a bar pinned near the bottom edge. */}
          <RadixPopover.Portal>
            <RadixPopover.Content
              sideOffset={8}
              collisionPadding={8}
              // Escape is the overlay's to handle (see `openPopover` there):
              // if Radix closed this itself, the state change would re-register
              // the overlay's key listener mid-dispatch and the same press
              // would go on to disarm the tool.
              onEscapeKeyDown={(e) => e.preventDefault()}
              onPointerDown={(e) => e.stopPropagation()}
              className="z-50 w-64 max-h-[80vh] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)] p-3 flex flex-col gap-3"
            >
              {SHOWS_COLOR.includes(optionsFor) && (
                <Field label="Color">
                  <ColorPicker
                    value={style.stroke}
                    onChange={(stroke) => onStyleChange({ stroke })}
                    open={openPopover === "color"}
                    onOpenChange={(o) => onOpenPopover(o ? "color" : "options")}
                  />
                </Field>
              )}
              {SHOWS_STROKE_WIDTH.includes(optionsFor) && (
                <Field label={`Stroke width ${style.strokeWidth}`}>
                  <Slider
                    aria-label="Stroke width"
                    value={style.strokeWidth}
                    {...RANGES.strokeWidth}
                    onChange={(strokeWidth) => onStyleChange({ strokeWidth })}
                  />
                </Field>
              )}
              {!STROKE_ONLY.includes(optionsFor) && (
                <ToolOptions tool={optionsFor} style={style} onStyleChange={onStyleChange} />
              )}
              {selectedShape && isRotatable(selectedShape) && (
                <Field label={`Rotation ${signedRotation(selectedShape.rotation ?? 0)}\u00b0`}>
                  <Slider
                    aria-label="Rotation"
                    // Signed -180..180 so the untouched default sits at the
                    // centre of the track, matching the editor's panel.
                    value={signedRotation(selectedShape.rotation ?? 0)}
                    {...RANGES.rotation}
                    onChange={onRotate}
                  />
                </Field>
              )}
              {onDeleteSelected && (
                // Same filled danger button the editor's properties panel
                // uses: as a bare text row it sat on the dropdown's own
                // background and did not read as something to press.
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={onDeleteSelected}
                >
                  Delete
                </Button>
              )}
              <RadixPopover.Arrow className="fill-[var(--surface)]" />
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      ) : (
        // Holds the chevron's place. The bar is centred on the selection, so
        // letting it grow when a tool is armed would shift every button
        // sideways under the pointer that just armed it.
        <div aria-hidden className="w-6 h-8" />
      )}

      <div className="w-px h-6 bg-[var(--border)] mx-1" />

      <button
        type="button"
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={onUndo}
        className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--fg)] hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={onRedo}
        className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--fg)] hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Redo2 size={16} />
      </button>
    </div>
  );
}

/** A labelled on/off row with a colour picker revealed when it is on -- the
 * shape the editor uses for Fill and for a text background. */
function OptionalColor({
  label,
  color,
  fallback,
  onChange,
}: {
  label: string;
  color: string | null;
  fallback: string;
  onChange: (color: string | null) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--fg)]">{label}</span>
        <Switch
          aria-label={label}
          checked={color !== null}
          onChange={(on) => onChange(on ? fallback : null)}
        />
      </div>
      {color !== null && <ColorPicker value={color} onChange={onChange} />}
    </>
  );
}

/** The per-tool settings, mirroring the editor's properties panel field for
 * field -- same labels, same controls, same ranges. The two surfaces edit the
 * same shapes, so a setting that reads one way here and another way there is
 * the same setting telling two stories. */
function ToolOptions({
  tool,
  style,
  onStyleChange,
}: {
  tool: ToolId;
  style: Style;
  onStyleChange: (partial: Partial<Style>) => void;
}) {
  switch (tool) {
    case "rect":
    case "ellipse":
      return (
        <>
          <Field label="Fill">
            <OptionalColor
              label="Filled"
              color={style.fill}
              fallback={style.stroke}
              onChange={(fill) => onStyleChange({ fill })}
            />
          </Field>
          {tool === "rect" && (
            <Field label={`Corner radius ${style.radius}`}>
              <Slider
                aria-label="Corner radius"
                value={style.radius}
                {...RANGES.cornerRadius}
                onChange={(radius) => onStyleChange({ radius })}
              />
            </Field>
          )}
        </>
      );

    case "arrow":
    case "line":
      return (
        <>
          <Field label="Arrow head">
            <Select
              aria-label="Arrow head"
              value={style.arrowStyle}
              options={ARROW_STYLES}
              onChange={(v) => onStyleChange({ arrowStyle: v as Style["arrowStyle"] })}
            />
          </Field>
          <Field label="Shaft">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--fg)]">Thick banner</span>
              <Switch
                aria-label="Thick banner"
                checked={style.arrowBanner}
                onChange={(arrowBanner) => onStyleChange({ arrowBanner })}
              />
            </div>
          </Field>
        </>
      );

    case "text":
      return (
        <>
          <Field label={`Font size ${style.fontSize}`}>
            <Slider
              aria-label="Font size"
              value={style.fontSize}
              {...RANGES.fontSize}
              onChange={(fontSize) => onStyleChange({ fontSize })}
            />
          </Field>
          <Field label="Format">
            <div className="flex items-center gap-1.5">
              <FormatToggle
                label="Bold"
                active={style.textBold}
                onClick={() => onStyleChange({ textBold: !style.textBold })}
              >
                <Bold size={16} />
              </FormatToggle>
              <FormatToggle
                label="Italic"
                active={style.textItalic}
                onClick={() => onStyleChange({ textItalic: !style.textItalic })}
              >
                <Italic size={16} />
              </FormatToggle>
              <FormatToggle
                label="Underline"
                active={style.textUnderline}
                onClick={() => onStyleChange({ textUnderline: !style.textUnderline })}
              >
                <Underline size={16} />
              </FormatToggle>
            </div>
          </Field>
          <Field label="Alignment">
            <Segmented
              fullWidth
              size="sm"
              aria-label="Text alignment"
              value={style.textAlign}
              options={TEXT_ALIGNMENTS}
              onChange={(textAlign) => onStyleChange({ textAlign })}
            />
          </Field>
          <Field label="Background">
            <OptionalColor
              label="Background"
              color={style.textBgColor}
              fallback="#000000"
              onChange={(textBgColor) => onStyleChange({ textBgColor })}
            />
          </Field>
        </>
      );

    case "pixelate":
      return (
        <>
          <Field label="Censor with">
            <Segmented
              fullWidth
              size="sm"
              aria-label="Censor mode"
              value={style.censorMode}
              onChange={(v) => onStyleChange({ censorMode: v as Style["censorMode"] })}
              options={CENSOR_MODES}
            />
          </Field>
          {style.censorMode === "solid" ? (
            <Field label="Color">
              <ColorPicker
                value={style.censorColor}
                onChange={(censorColor) => onStyleChange({ censorColor })}
              />
            </Field>
          ) : (
            <Field
              label={`${style.censorMode === "blur" ? "Blur amount" : "Block size"} ${style.pixelateBlock}`}
            >
              <Slider
                aria-label={style.censorMode === "blur" ? "Blur amount" : "Pixelate block size"}
                value={style.pixelateBlock}
                {...RANGES.censorAmount}
                onChange={(pixelateBlock) => onStyleChange({ pixelateBlock })}
              />
            </Field>
          )}
        </>
      );

    case "spotlight":
      return (
        <>
          <Field label="Shape">
            <Segmented
              fullWidth
              size="sm"
              aria-label="Spotlight shape"
              value={style.spotlightForm}
              onChange={(v) => onStyleChange({ spotlightForm: v as Style["spotlightForm"] })}
              options={SPOTLIGHT_FORMS}
            />
          </Field>
          <Field label={`Dim outside ${Math.round(style.spotlightDim * 100)}%`}>
            <Slider
              aria-label="Spotlight dim"
              value={Math.round(style.spotlightDim * 100)}
              {...RANGES.spotlightDim}
              onChange={(v) => onStyleChange({ spotlightDim: v / 100 })}
            />
          </Field>
          {style.spotlightForm === "rect" && (
            <Field label={`Corner radius ${style.radius}`}>
              <Slider
                aria-label="Corner radius"
                value={style.radius}
                min={0}
                max={100}
                onChange={(radius) => onStyleChange({ radius })}
              />
            </Field>
          )}
        </>
      );

    case "marker":
      return (
        <Field label={`Marker size ${style.markerSize}`}>
          <Slider
            aria-label="Marker size"
            value={style.markerSize}
            {...RANGES.markerSize}
            onChange={(markerSize) => onStyleChange({ markerSize })}
          />
        </Field>
      );

    case "stamp":
      return (
        <>
          <Field label="Emoji">
            <StampPicker
              value={style.stampEmoji}
              onChange={(stampEmoji) => onStyleChange({ stampEmoji })}
            />
          </Field>
          {/* A stamp's size is `markerSize * 4` (see `createStamp`), so the
            * slider presents that product and stores the factor -- same range
            * the editor offers for the same shape. */}
          <Field label={`Size ${style.markerSize * 4}`}>
            <Slider
              aria-label="Stamp size"
              value={style.markerSize * 4}
              {...RANGES.stampSize}
              onChange={(size) => onStyleChange({ markerSize: Math.round(size / 4) })}
            />
          </Field>
        </>
      );

    case "loupe":
      return (
        <>
          <Field label={`Magnification ${style.loupeFactor}x`}>
            <Slider
              aria-label="Magnification"
              value={style.loupeFactor}
              {...RANGES.loupeFactor}
              onChange={(loupeFactor) => onStyleChange({ loupeFactor })}
            />
          </Field>
          <Field label={`Ring width ${style.strokeWidth}`}>
            <Slider
              aria-label="Ring width"
              value={style.strokeWidth}
              {...RANGES.strokeWidth}
              onChange={(strokeWidth) => onStyleChange({ strokeWidth })}
            />
          </Field>
        </>
      );

    default:
      return null;
  }
}

/** Same square toggle the editor's properties panel uses for bold/italic/
 * underline. */
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

