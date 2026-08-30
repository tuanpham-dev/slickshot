import { Popover as RadixPopover } from "radix-ui";

export const SWATCHES = [
  "#e2372f", // red
  "#f0912b", // orange
  "#f2c94c", // yellow
  "#27ae60", // green
  "#2f80ed", // blue
  "#9b51e0", // purple
  "#f2f2f2", // near-white
  "#111318", // near-black
];

interface ColorSwatchProps {
  color: string;
  selected?: boolean;
  onClick: () => void;
  label?: string;
}

export function ColorSwatch({ color, selected, onClick, label }: ColorSwatchProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? color}
      aria-pressed={selected}
      className={[
        "w-8 h-8 rounded-full border-2 transition-transform duration-[var(--duration-fast)] focus-visible:shadow-[var(--focus-ring)]",
        selected
          ? "border-[var(--accent)] scale-110"
          : "border-[var(--border)] hover:scale-105",
      ].join(" ")}
      style={{ background: color }}
    />
  );
}

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  /** Optional controlled state, for callers that need Escape and outside
   * clicks handled somewhere other than inside this component -- the capture
   * overlay owns those keys itself. Omit both to keep it self-managing. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ColorPicker({ value, onChange, open, onOpenChange }: ColorPickerProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          aria-label={`Color: ${value}`}
          className="w-8 h-8 rounded-full border-2 border-[var(--border-strong)] focus-visible:shadow-[var(--focus-ring)]"
          style={{ background: value }}
        />
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          sideOffset={8}
          // When controlled, the caller owns Escape: closing here as well
          // would swap its key listener mid-dispatch and the same keypress
          // would fall through to whatever it handles next.
          onEscapeKeyDown={open === undefined ? undefined : (e) => e.preventDefault()}
          className="z-50 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] p-3 flex flex-col gap-3 w-52"
        >
          <div className="grid grid-cols-4 gap-2">
            {SWATCHES.map((c) => (
              <ColorSwatch key={c} color={c} selected={c === value} onClick={() => onChange(c)} />
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            Custom
            <input
              type="color"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-transparent cursor-pointer"
            />
          </label>
          <RadixPopover.Arrow className="fill-[var(--surface)]" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
