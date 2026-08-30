import {
  ArrowUpRight,
  MousePointer2,
  Circle,
  CircleDot,
  Focus,
  Grid3x3,
  Highlighter,
  Minus,
  Pencil,
  Smile,
  Square,
  Type,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import type { ToolId } from "../editor/types";

export interface OverlayToolMeta {
  id: ToolId;
  label: string;
  icon: LucideIcon;
}

/** Always first on the bar and never configurable: without it there is no way
 * to get back to a shape once it is drawn. Kept out of `OVERLAY_TOOLS` so the
 * Settings picker cannot offer to remove it. */
export const SELECT_TOOL: OverlayToolMeta = {
  id: "select",
  label: "Select",
  icon: MousePointer2,
};

/** Every tool the capture overlay can offer, in the order the Settings
 * picker lists them. Labels and icons match the editor's toolbar so a tool
 * looks the same in both places. Must stay in step with `OVERLAY_TOOL_IDS`
 * in `settings.rs`, which drops any id it does not recognise. */
export const OVERLAY_TOOLS: OverlayToolMeta[] = [
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
  { id: "line", label: "Line", icon: Minus },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "freehand", label: "Freehand", icon: Pencil },
  { id: "text", label: "Text", icon: Type },
  { id: "highlight", label: "Highlighter", icon: Highlighter },
  { id: "pixelate", label: "Censor", icon: Grid3x3 },
  { id: "spotlight", label: "Spotlight", icon: Focus },
  { id: "marker", label: "Numbered marker", icon: CircleDot },
  { id: "stamp", label: "Emoji stamp", icon: Smile },
  { id: "loupe", label: "Magnifier", icon: ZoomIn },
];

/** Resolves configured ids to tool metadata, dropping anything unrecognised
 * -- the setting is user-editable JSON and can name a tool this build does
 * not have. */
export function resolveOverlayTools(ids: string[]): OverlayToolMeta[] {
  return ids
    .map((id) => OVERLAY_TOOLS.find((t) => t.id === id))
    .filter((t): t is OverlayToolMeta => t !== undefined);
}
