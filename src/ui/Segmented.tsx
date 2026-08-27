import { useRef } from "react";

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
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // WAI-ARIA radiogroup pattern: only the selected option (or the first, if
  // nothing matches `value`) is a tab stop -- arrow keys move focus *and*
  // selection between options, same as native <input type="radio">. Before
  // this, every option had its own default tabindex, so Tab stopped on each
  // one individually instead of once for the whole group.
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function move(from: number, delta: number) {
    const next = (from + delta + options.length) % options.length;
    buttonRefs.current[next]?.focus();
    onChange(options[next].value);
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(index, -1);
        break;
      case "Home":
        e.preventDefault();
        buttonRefs.current[0]?.focus();
        onChange(options[0].value);
        break;
      case "End":
        e.preventDefault();
        buttonRefs.current[options.length - 1]?.focus();
        onChange(options[options.length - 1].value);
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={rest["aria-label"]}
      className="inline-flex items-center rounded-[var(--radius-md)] bg-[var(--surface-2)] p-0.5 border border-[var(--border)]"
    >
      {options.map((opt, index) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
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
