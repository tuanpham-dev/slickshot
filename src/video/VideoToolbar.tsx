import {
  ArrowUpRight,
  Circle,
  Crop,
  Grid3x3,
  Highlighter,
  Minus,
  MousePointer2,
  Pencil,
  Smile,
  Square,
  Type,
  CircleDot,
} from "lucide-react";
import { IconButton } from "../ui/IconButton";
import type { ToolId } from "../editor/types";
import { VIDEO_TOOLS } from "./videoTools";

/** Icon and label per tool, for the subset a recording can use.
 *
 * A separate component from the image editor's `Toolbar` rather than that one
 * behind a whitelist: `Toolbar` carries a dozen props for things a clip has no
 * equivalent of (backdrop, adjustments, redact-PII, insert-image, pin), and
 * making each of them optional to serve one caller would put the risk in the
 * component the image editor depends on. The tools themselves are the same
 * `ToolId`s driving the same store, so they behave identically.
 */
const TOOL_META: Record<string, { icon: React.ReactNode; label: string; key?: string }> = {
  select: { icon: <MousePointer2 size={17} />, label: "Select", key: "V" },
  crop: { icon: <Crop size={17} />, label: "Crop", key: "C" },
  rect: { icon: <Square size={17} />, label: "Rectangle", key: "R" },
  ellipse: { icon: <Circle size={17} />, label: "Ellipse", key: "E" },
  arrow: { icon: <ArrowUpRight size={17} />, label: "Arrow", key: "A" },
  line: { icon: <Minus size={17} />, label: "Line", key: "L" },
  freehand: { icon: <Pencil size={17} />, label: "Draw", key: "D" },
  text: { icon: <Type size={17} />, label: "Text", key: "T" },
  highlight: { icon: <Highlighter size={17} />, label: "Highlight", key: "H" },
  marker: { icon: <CircleDot size={17} />, label: "Step marker", key: "M" },
  pixelate: { icon: <Grid3x3 size={17} />, label: "Censor", key: "P" },
  stamp: { icon: <Smile size={17} />, label: "Sticker" },
};

export interface VideoToolbarProps {
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
}

export function VideoToolbar({ tool, onToolChange }: VideoToolbarProps) {
  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label="Video tools">
      {VIDEO_TOOLS.map((id) => {
        const meta = TOOL_META[id];
        if (!meta) return null;
        return (
          <IconButton
            key={id}
            label={meta.key ? `${meta.label} (${meta.key})` : meta.label}
            icon={meta.icon}
            size="sm"
            variant={tool === id ? "primary" : "ghost"}
            onClick={() => onToolChange(id)}
            aria-pressed={tool === id}
          />
        );
      })}
    </div>
  );
}
