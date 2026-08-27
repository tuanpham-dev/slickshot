import { Switch as RadixSwitch } from "radix-ui";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  "aria-label": string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, disabled, ...rest }: SwitchProps) {
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      className={[
        "relative w-9 h-5 rounded-full transition-colors duration-[var(--duration-fast)]",
        "data-[state=checked]:bg-[var(--accent)] data-[state=unchecked]:bg-[var(--surface-2)]",
        "border border-[var(--border)] disabled:opacity-50 disabled:cursor-not-allowed",
        "focus-visible:shadow-[var(--focus-ring)]",
      ].join(" ")}
    >
      <RadixSwitch.Thumb
        className={[
          "block w-3.5 h-3.5 rounded-full bg-[var(--surface)] shadow-[var(--shadow-sm)]",
          "transition-transform duration-[var(--duration-fast)] translate-x-0.5",
          "data-[state=checked]:translate-x-[18px]",
        ].join(" ")}
      />
    </RadixSwitch.Root>
  );
}
