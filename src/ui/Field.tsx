import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}

export function Field({ label, hint, error, children, htmlFor }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-[var(--fg-muted)]">
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-xs text-[var(--danger)]">{error}</span>
      ) : hint ? (
        <span className="text-xs text-[var(--fg-muted)]">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={[
        "h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm",
        "text-[var(--fg)] placeholder:text-[var(--fg-subtle)]",
        "focus-visible:shadow-[var(--focus-ring)] focus-visible:border-[var(--accent)]",
        props.className ?? "",
      ].join(" ")}
    />
  );
}
