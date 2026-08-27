import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-6">
      <div className="text-[var(--fg-subtle)] mb-1">{icon}</div>
      <div className="text-sm font-medium text-[var(--fg)]">{title}</div>
      {description && (
        <div className="text-xs text-[var(--fg-muted)] max-w-[280px]">{description}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
