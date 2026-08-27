import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "flat-accent" | "flat-danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconOnly?: boolean;
}

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] border border-transparent",
  secondary:
    "bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--surface-hover)] border border-[var(--border)]",
  ghost:
    "bg-transparent text-[var(--fg)] hover:bg-[var(--surface-hover)] border border-transparent",
  danger:
    "bg-[var(--danger)] text-[var(--danger-fg)] hover:bg-[var(--danger-hover)] border border-transparent",
  // Flat, saturated variants for calling out the two highest-stakes actions
  // (export "Copy" and the close-guard "Discard") -- deliberately not tied
  // to `--accent`/`--danger`, which drive focus rings, selection outlines,
  // toggles, etc. app-wide; changing those would have re-themed everything,
  // not just these two buttons.
  "flat-accent": "bg-[#1570ef] text-white hover:bg-[#115bc3] border border-transparent",
  "flat-danger": "bg-[#dc2626] text-white hover:bg-[#b41f1f] border border-transparent",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-11 px-4 text-sm gap-2",
};

const iconOnlySizeClass: Record<ButtonSize, string> = {
  sm: "w-8 h-8 p-0",
  md: "w-9 h-9 p-0",
  lg: "w-11 h-11 p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, iconOnly, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        "inline-flex items-center justify-center rounded-[var(--radius-md)] font-medium",
        "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "focus-visible:shadow-[var(--focus-ring)]",
        iconOnly ? iconOnlySizeClass[size] : "",
        variantClass[variant],
        iconOnly ? "" : sizeClass[size],
        className,
      ].join(" ")}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
          aria-hidden
        />
      ) : (
        icon
      )}
      {!iconOnly && children}
    </button>
  );
});
