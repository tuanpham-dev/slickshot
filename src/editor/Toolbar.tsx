import {
  MousePointer2,
  Square,
  Circle,
  ArrowUpRight,
  Minus,
  Pencil,
  Type,
  Highlighter,
  Grid3x3,
  Focus,
  CircleDot,
  Crop,
  ScanText,
  Pipette,
  Ruler,
  ImagePlus,
  Frame,
  Undo2,
  Redo2,
} from "lucide-react";
import { IconButton } from "../ui/IconButton";
import type { ToolId } from "./types";

interface ToolbarProps {
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onInsertImage: () => void;
  onToggleBackdrop: () => void;
  backdropEnabled: boolean;
  /** True when `ocr_engine_status` reports Tesseract missing -- the Extract
   * text tool dims and shows a warning marker; `onToolChange` is still
   * called (the parent redirects to install guidance instead of arming
   * region-drag), so keyboard shortcuts and clicks share one redirect path. */
  ocrUnavailable: boolean;
}

const TOOLS: { id: ToolId; icon: React.ReactNode; label: string; shortcut: string }[] = [
  { id: "select", icon: <MousePointer2 size={20} />, label: "Select", shortcut: "V" },
  { id: "rect", icon: <Square size={20} />, label: "Rectangle", shortcut: "R" },
  { id: "ellipse", icon: <Circle size={20} />, label: "Ellipse", shortcut: "E" },
  { id: "arrow", icon: <ArrowUpRight size={20} />, label: "Arrow", shortcut: "A" },
  { id: "line", icon: <Minus size={20} />, label: "Line", shortcut: "L" },
  { id: "freehand", icon: <Pencil size={20} />, label: "Freehand", shortcut: "P" },
  { id: "text", icon: <Type size={20} />, label: "Text", shortcut: "T" },
  { id: "highlight", icon: <Highlighter size={20} />, label: "Highlighter", shortcut: "H" },
  { id: "pixelate", icon: <Grid3x3 size={20} />, label: "Pixelate", shortcut: "X" },
  { id: "spotlight", icon: <Focus size={20} />, label: "Spotlight", shortcut: "W" },
  { id: "marker", icon: <CircleDot size={20} />, label: "Numbered marker", shortcut: "M" },
  { id: "crop", icon: <Crop size={20} />, label: "Crop", shortcut: "C" },
  { id: "ocr", icon: <ScanText size={20} />, label: "Extract text", shortcut: "O" },
  { id: "eyedropper", icon: <Pipette size={20} />, label: "Pick color", shortcut: "I" },
  { id: "measure", icon: <Ruler size={20} />, label: "Measure", shortcut: "U" },
];

export function Toolbar({
  tool,
  onToolChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onInsertImage,
  onToggleBackdrop,
  backdropEnabled,
  ocrUnavailable,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 h-16 border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-1">
        {TOOLS.map((t) => {
          const unavailable = t.id === "ocr" && ocrUnavailable;
          return (
            <div key={t.id} className="relative">
              <IconButton
                label={unavailable ? `${t.label} (Tesseract not installed)` : t.label}
                shortcut={t.shortcut}
                icon={t.icon}
                size="lg"
                active={tool === t.id}
                className={unavailable ? "opacity-50" : ""}
                onClick={() => onToolChange(t.id)}
              />
              {unavailable && (
                <span
                  className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--danger)] pointer-events-none"
                  aria-hidden
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="w-px h-8 bg-[var(--border)] mx-2.5" />
      <div className="flex items-center gap-1">
        <IconButton
          label="Insert image"
          icon={<ImagePlus size={20} />}
          size="lg"
          onClick={onInsertImage}
        />
        <IconButton
          label="Backdrop"
          icon={<Frame size={20} />}
          size="lg"
          active={backdropEnabled}
          onClick={onToggleBackdrop}
        />
      </div>
      <div className="w-px h-8 bg-[var(--border)] mx-2.5" />
      <div className="flex items-center gap-1">
        <IconButton
          label="Undo"
          shortcut="Ctrl+Z"
          icon={<Undo2 size={20} />}
          size="lg"
          onClick={onUndo}
          disabled={!canUndo}
        />
        <IconButton
          label="Redo"
          shortcut="Ctrl+Shift+Z"
          icon={<Redo2 size={20} />}
          size="lg"
          onClick={onRedo}
          disabled={!canRedo}
        />
      </div>
    </div>
  );
}
