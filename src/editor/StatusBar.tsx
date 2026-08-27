import { Minus, Plus, Maximize, Minimize } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import type { ImgPoint } from "./types";

interface StatusBarProps {
  zoom: number;
  imageWidth: number;
  imageHeight: number;
  cursor: ImgPoint | null;
  onZoomChange: (zoom: number) => void;
  onFit: () => void;
}

const AT_ORIGINAL_SIZE_EPSILON = 0.001;

export function StatusBar({ zoom, imageWidth, imageHeight, cursor, onZoomChange, onFit }: StatusBarProps) {
  const atOriginalSize = Math.abs(zoom - 1) < AT_ORIGINAL_SIZE_EPSILON;
  return (
    <div className="flex items-center justify-between h-8 px-3 border-t border-[var(--border)] bg-[var(--surface)] text-[11px] text-[var(--fg-muted)] font-mono">
      <div className="flex items-center gap-3">
        <span>
          {imageWidth} × {imageHeight}
        </span>
        {cursor && (
          <span>
            {Math.round(cursor.x)}, {Math.round(cursor.y)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <IconButton
          label="Zoom out"
          icon={<Minus size={14} />}
          size="sm"
          onClick={() => onZoomChange(zoom - 0.25)}
        />
        <span className="w-12 text-center">{Math.round(zoom * 100)}%</span>
        <IconButton
          label="Zoom in"
          icon={<Plus size={14} />}
          size="sm"
          onClick={() => onZoomChange(zoom + 0.25)}
        />
        <IconButton
          label={atOriginalSize ? "Fit to window" : "Actual size (100%)"}
          icon={atOriginalSize ? <Maximize size={14} /> : <Minimize size={14} />}
          size="sm"
          onClick={onFit}
        />
      </div>
    </div>
  );
}
