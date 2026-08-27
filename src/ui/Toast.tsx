import { Toast as RadixToast } from "radix-ui";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastContextValue {
  show: (toast: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

const iconFor: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 size={16} className="text-[var(--success)]" />,
  error: <XCircle size={16} className="text-[var(--danger)]" />,
  info: <CheckCircle2 size={16} className="text-[var(--accent)]" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const show = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      <RadixToast.Provider swipeDirection="right" duration={3000}>
        {children}
        {toasts.map((t) => (
          <RadixToast.Root
            key={t.id}
            onOpenChange={(open) => !open && dismiss(t.id)}
            className="flex items-start gap-2.5 rounded-[var(--radius-md)] bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-lg)] px-3.5 py-3 min-w-[280px] max-w-[360px] data-[state=open]:animate-[toastSlideIn_var(--duration-base)_var(--ease-out)]"
          >
            <span className="mt-0.5 shrink-0">{iconFor[t.kind]}</span>
            <div className="flex-1 min-w-0">
              <RadixToast.Title className="text-sm font-medium text-[var(--fg)]">
                {t.title}
              </RadixToast.Title>
              {t.description && (
                <RadixToast.Description className="text-xs text-[var(--fg-muted)] mt-0.5">
                  {t.description}
                </RadixToast.Description>
              )}
              {t.actionLabel && t.onAction && (
                <RadixToast.Action asChild altText={t.actionLabel}>
                  <button
                    onClick={t.onAction}
                    className="mt-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
                  >
                    {t.actionLabel}
                  </button>
                </RadixToast.Action>
              )}
            </div>
            <RadixToast.Close
              aria-label="Dismiss"
              className="inline-flex items-center justify-center w-8 h-8 -m-1.5 -mr-2 rounded-[var(--radius-sm)] shrink-0 text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--focus-ring)]"
            >
              <X size={14} />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
