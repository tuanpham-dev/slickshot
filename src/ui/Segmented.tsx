export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
  /** "sm" brings the *outer* height down to 32px, matching Button's
   * `size="sm"` (the inner options are already h-8; the default's 2px
   * padding on top of that is what makes it taller than a sm button). */
  size?: "sm" | "md";
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ...rest
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={rest["aria-label"]}
      className="inline-flex items-center rounded-[var(--radius-md)] bg-[var(--surface-2)] p-0.5 border border-[var(--border)]"
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={[
              size === "sm" ? "px-2.5 h-7" : "px-2.5 h-8",
              "rounded-[calc(var(--radius-md)-2px)] text-xs font-medium transition-colors",
              "duration-[var(--duration-fast)] focus-visible:shadow-[var(--focus-ring)]",
              selected
                ? "bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-sm)]"
                : "text-[var(--fg-muted)] hover:text-[var(--fg)]",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
