import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { Tooltip } from "./Tooltip";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  /** Hides the tooltip -- see `Tooltip`'s `suppressed`. */
  tooltipSuppressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, icon, variant = "ghost", size = "md", active, tooltipSuppressed, className = "", ...rest },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut} suppressed={tooltipSuppressed}>
      <Button
        ref={ref}
        iconOnly
        icon={icon}
        variant={variant}
        size={size}
        aria-label={label}
        aria-pressed={active}
        className={[active ? "bg-[var(--accent)]! text-[var(--accent-fg)]!" : "", className].join(" ")}
        {...rest}
      >
        {null}
      </Button>
    </Tooltip>
  );
});
