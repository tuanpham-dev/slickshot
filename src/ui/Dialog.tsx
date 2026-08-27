import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./Button";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-[var(--overlay-mask)] z-40 data-[state=open]:animate-[fadeIn_var(--duration-base)_var(--ease-out)]" />
        <RadixDialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[380px] rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-lg)] p-5 data-[state=open]:animate-[fadeIn_var(--duration-base)_var(--ease-out)]">
          <div className="flex items-start justify-between gap-3 mb-1">
            <RadixDialog.Title className="text-sm font-semibold text-[var(--fg)]">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <button
                aria-label="Close"
                className="inline-flex items-center justify-center w-8 h-8 -m-1 -mr-2 rounded-[var(--radius-sm)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] shrink-0 focus-visible:shadow-[var(--focus-ring)]"
              >
                <X size={16} />
              </button>
            </RadixDialog.Close>
          </div>
          {description && (
            <RadixDialog.Description className="text-xs text-[var(--fg-muted)] mb-4">
              {description}
            </RadixDialog.Description>
          )}
          {children}
          {footer && <div className="flex justify-end gap-2 mt-5">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "flat-danger" : "primary"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
