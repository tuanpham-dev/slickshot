import { Select as RadixSelect } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
  disabled?: boolean;
  /** "sm" matches Button's `size="sm"` (h-8) -- used to line up with a
   * neighboring secondary button, e.g. Settings' "Save folder" row. */
  size?: "sm" | "md";
}

export function Select<T extends string>({
  options,
  value,
  onChange,
  disabled,
  size = "md",
  ...rest
}: SelectProps<T>) {
  return (
    <RadixSelect.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={rest["aria-label"]}
        className={[
          "inline-flex items-center justify-between gap-2 rounded-[var(--radius-md)]",
          size === "sm" ? "h-8" : "h-9",
          "border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--fg)]",
          "hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--focus-ring)]",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        ].join(" ")}
      >
        <RadixSelect.Value />
        <RadixSelect.Icon>
          <ChevronDown size={14} className="text-[var(--fg-muted)]" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          className="z-50 overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] max-h-[var(--radix-select-content-available-height)]"
          position="popper"
          sideOffset={4}
        >
          <RadixSelect.ScrollUpButton className="flex items-center justify-center h-6 bg-[var(--surface)] text-[var(--fg-muted)] cursor-default">
            <ChevronUp size={14} />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1">
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                className="relative flex items-center h-8 pl-7 pr-3 rounded-[var(--radius-sm)] text-sm text-[var(--fg)] outline-none data-[highlighted]:bg-[var(--surface-hover)] cursor-pointer"
              >
                <RadixSelect.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check size={14} className="text-[var(--accent)]" />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex items-center justify-center h-6 bg-[var(--surface)] text-[var(--fg-muted)] cursor-default">
            <ChevronDown size={14} />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
