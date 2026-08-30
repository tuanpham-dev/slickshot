import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
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
  Smile,
  ZoomIn,
  ImagePlus,
  Frame,
  SlidersHorizontal,
  ShieldAlert,
  SmilePlus,
  Pin,
} from "lucide-react";
import { IconButton } from "../ui/IconButton";
import type { ToolId } from "./types";

interface ToolbarProps {
  tool: ToolId;
  onToolChange: (tool: ToolId) => void;
  onInsertImage: () => void;
  onToggleBackdrop: () => void;
  backdropEnabled: boolean;
  /** True when `ocr_engine_status` reports Tesseract missing -- the Extract
   * text tool dims and shows a warning marker; `onToolChange` is still
   * called (the parent redirects to install guidance instead of arming
   * region-drag), so keyboard shortcuts and clicks share one redirect path. */
  ocrUnavailable: boolean;
  onToggleAdjust: () => void;
  adjustOpen: boolean;
  onRedactPii: () => void;
  onCensorFaces: () => void;
  /** True while a redact/face pass is running, so the two batch actions
   * can't be re-fired mid-flight. */
  busy: boolean;
  onPin: () => void;
}

/** An entry in the scrolling row: either a tool that stays selected, or a
 * one-shot command that runs and hands control straight back. */
type BarItem =
  | { kind: "tool"; id: ToolId; icon: React.ReactNode; label: string; shortcut: string }
  | { kind: "command"; id: CommandId; icon: React.ReactNode; label: string; shortcut?: string };

type CommandId = "insert" | "redact" | "faces";

/** Ordered by what each item is *for*, so related tools sit together without
 * needing a rule drawn between them: shapes, then labels, then emphasis, then
 * the things that hide something, then whole-image operations, then the
 * read-only inspectors. Redact and Censor faces sit beside the Censor tool
 * because all three produce the same kind of shape; Insert image sits with
 * text and stamps, since all four add content on top of the capture.
 *
 * Kept as nested arrays purely to keep that grouping legible in source -- the
 * row renders flat. */
const BAR_ITEMS: BarItem[] = ([
  [{ kind: "tool", id: "select", icon: <MousePointer2 size={20} />, label: "Select", shortcut: "V" }],
  [
    { kind: "tool", id: "rect", icon: <Square size={20} />, label: "Rectangle", shortcut: "R" },
    { kind: "tool", id: "ellipse", icon: <Circle size={20} />, label: "Ellipse", shortcut: "E" },
    { kind: "tool", id: "arrow", icon: <ArrowUpRight size={20} />, label: "Arrow", shortcut: "A" },
    { kind: "tool", id: "line", icon: <Minus size={20} />, label: "Line", shortcut: "L" },
    { kind: "tool", id: "freehand", icon: <Pencil size={20} />, label: "Freehand", shortcut: "P" },
  ],
  [
    { kind: "tool", id: "text", icon: <Type size={20} />, label: "Text", shortcut: "T" },
    { kind: "tool", id: "marker", icon: <CircleDot size={20} />, label: "Numbered marker", shortcut: "M" },
    { kind: "tool", id: "stamp", icon: <Smile size={20} />, label: "Emoji stamp", shortcut: "G" },
    { kind: "command", id: "insert", icon: <ImagePlus size={20} />, label: "Insert image" },
  ],
  [
    { kind: "tool", id: "highlight", icon: <Highlighter size={20} />, label: "Highlighter", shortcut: "H" },
    { kind: "tool", id: "spotlight", icon: <Focus size={20} />, label: "Spotlight", shortcut: "W" },
    { kind: "tool", id: "loupe", icon: <ZoomIn size={20} />, label: "Magnifier", shortcut: "Z" },
  ],
  [
    { kind: "tool", id: "pixelate", icon: <Grid3x3 size={20} />, label: "Censor", shortcut: "X" },
    { kind: "command", id: "redact", icon: <ShieldAlert size={20} />, label: "Redact personal data" },
    { kind: "command", id: "faces", icon: <SmilePlus size={20} />, label: "Censor faces" },
  ],
  [{ kind: "tool", id: "crop", icon: <Crop size={20} />, label: "Crop", shortcut: "C" }],
  [
    { kind: "tool", id: "ocr", icon: <ScanText size={20} />, label: "Extract text", shortcut: "O" },
    { kind: "tool", id: "eyedropper", icon: <Pipette size={20} />, label: "Pick color", shortcut: "I" },
    { kind: "tool", id: "measure", icon: <Ruler size={20} />, label: "Measure", shortcut: "U" },
  ],
] satisfies BarItem[][]).flat();

export function Toolbar({
  tool,
  onToolChange,
  onInsertImage,
  onToggleBackdrop,
  backdropEnabled,
  ocrUnavailable,
  onToggleAdjust,
  adjustOpen,
  onRedactPii,
  onCensorFaces,
  busy,
  onPin,
}: ToolbarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which sides still have tools beyond the visible edge, so the fades only
  // appear when there is actually something to scroll to.
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const syncOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // The 1px slack absorbs sub-pixel rounding at fractional zoom levels,
    // which would otherwise leave an indicator stuck on at either end.
    setOverflow({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncOverflow();

    // A vertical wheel is the natural gesture over a horizontal strip, but
    // browsers only send it to the nearest *vertically* scrollable ancestor
    // -- which here is nothing, so the row would sit still unless the user
    // knew to hold Shift. Translating deltaY into scrollLeft makes a plain
    // wheel work; horizontal deltas (trackpads, Shift+wheel) already arrive
    // as deltaX and are left to the browser.
    //
    // Registered non-passively because it calls preventDefault; React's own
    // onWheel is passive and could not.
    function onWheel(e: WheelEvent) {
      if (e.deltaY === 0) return;
      const max = el!.scrollWidth - el!.clientWidth;
      if (max <= 0) return;
      e.preventDefault();
      el!.scrollLeft += e.deltaY;
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", syncOverflow, { passive: true });
    // Catches the window being resized and the row's own content changing.
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", syncOverflow);
      observer.disconnect();
    };
  }, [syncOverflow]);

  function runCommand(id: CommandId) {
    if (id === "insert") return onInsertImage();
    if (id === "redact") return onRedactPii();
    return onCensorFaces();
  }

  /** One screenful is too far for a strip of icons; a few buttons per click
   * keeps the row's position easy to follow. */
  const SCROLL_STEP_PX = 160;

  /** Marks tools scrolled out of view, and scrolls toward them when clicked.
   *
   * The strip is a generous click target but stays transparent so the tools
   * behind it remain visible; only the chevron itself is drawn solid, as a
   * bordered pill, so it reads as a control rather than as decoration. */
  function EdgeScroll({ side }: { side: "left" | "right" }) {
    const Chevron = side === "left" ? ChevronLeft : ChevronRight;
    return (
      <button
        type="button"
        aria-label={side === "left" ? "Scroll tools left" : "Scroll tools right"}
        onClick={() =>
          scrollRef.current?.scrollBy({
            left: side === "left" ? -SCROLL_STEP_PX : SCROLL_STEP_PX,
            behavior: "smooth",
          })
        }
        className={`absolute top-0 bottom-0 ${
          side === "left" ? "left-0 justify-start" : "right-0 justify-end"
        } w-9 z-20 flex items-center group`}
      >
        <span className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-md)] text-[var(--fg)] group-hover:bg-[var(--accent)] group-hover:border-[var(--accent)] group-hover:text-white">
          <Chevron size={18} />
        </span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-3 h-16 border-b border-[var(--border)] bg-[var(--surface)] min-w-0">
      {/* Only the tool row gives way when the window is narrow: it scrolls,
          while the action group beside it stays pinned, so no action can be
          clipped off the right edge. */}
      <div className="relative min-w-0 flex-1">
        {overflow.left && <EdgeScroll side="left" />}
        {overflow.right && <EdgeScroll side="right" />}
        <div
          ref={scrollRef}
          className="flex items-center gap-1 min-w-0 overflow-x-auto slickshot-toolbar-scroll"
        >
          {BAR_ITEMS.map((item) => {
            // Redaction reads the image through OCR, so it is unavailable for
            // the same reason the Extract-text tool is.
            const needsOcr = item.id === "ocr" || item.id === "redact";
            const unavailable = needsOcr && ocrUnavailable;
            return (
              <div key={item.id} className="relative shrink-0">
                <IconButton
                  label={unavailable ? `${item.label} (Tesseract not installed)` : item.label}
                  shortcut={item.shortcut}
                  icon={item.icon}
                  size="lg"
                  active={item.kind === "tool" && tool === item.id}
                  className={unavailable ? "opacity-50" : ""}
                  disabled={item.kind === "command" && item.id !== "insert" && busy}
                  onClick={() => (item.kind === "tool" ? onToolChange(item.id) : runCommand(item.id))}
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
      </div>
      <div className="w-px h-8 bg-[var(--border)] mx-2.5 shrink-0" />
      {/* The three that act on the document as a whole stay put: they are the
          ones worth reaching for without scrolling, whatever tool is active. */}
      <div className="flex items-center gap-1 shrink-0">
        <IconButton
          label="Backdrop"
          icon={<Frame size={20} />}
          size="lg"
          active={backdropEnabled}
          onClick={onToggleBackdrop}
        />
        <IconButton
          label="Adjust image"
          icon={<SlidersHorizontal size={20} />}
          size="lg"
          active={adjustOpen}
          onClick={onToggleAdjust}
        />
        <IconButton label="Pin to screen" shortcut="Ctrl+P" icon={<Pin size={20} />} size="lg" onClick={onPin} />
      </div>
    </div>
  );
}
