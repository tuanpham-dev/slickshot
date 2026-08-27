import type { ReactNode } from "react";

export function Kbd({ children, inverted }: { children: ReactNode; inverted?: boolean }) {
  return (
    <kbd
      className={[
        "inline-flex items-center rounded-[3px] border px-1 py-0.5 text-[10px] font-mono leading-none",
        inverted
          ? "bg-[var(--bg)]/10 border-[var(--bg)]/25 text-[var(--bg)]"
          : "bg-[var(--surface-2)] border-[var(--border-strong)] text-[var(--fg-muted)]",
      ].join(" ")}
    >
      {children}
    </kbd>
  );
}
