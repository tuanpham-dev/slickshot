import { Slider as RadixSlider } from "radix-ui";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  "aria-label": string;
  disabled?: boolean;
}

export function Slider({ value, min, max, step = 1, onChange, disabled, ...rest }: SliderProps) {
  return (
    <RadixSlider.Root
      className="relative flex items-center select-none touch-none h-5 w-full data-[disabled]:opacity-50"
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={([v]) => onChange(v)}
      disabled={disabled}
      aria-label={rest["aria-label"]}
    >
      <RadixSlider.Track className="relative grow rounded-full h-1.5 bg-[var(--surface-2)]">
        <RadixSlider.Range className="absolute rounded-full h-full bg-[var(--accent)]" />
      </RadixSlider.Track>
      <RadixSlider.Thumb className="block w-4 h-4 rounded-full bg-[var(--surface)] border-2 border-[var(--accent)] shadow-[var(--shadow-sm)] focus-visible:shadow-[var(--focus-ring)]" />
    </RadixSlider.Root>
  );
}
