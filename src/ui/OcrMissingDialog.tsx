import { useState } from "react";
import { ClipboardCopy, RefreshCw } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { useToast } from "./Toast";
import { copyTextToClipboard, ocrEngineStatus } from "../lib/ipc";

interface OcrMissingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installHint: string;
  /** Called when "Check again" finds Tesseract now installed -- the caller
   * re-enables OCR and this dialog closes itself. */
  onAvailable: () => void;
}

/** Shared dialog for every OCR entry point (editor toolbar, main window
 * tile, Settings) when `ocr_engine_status` reports Tesseract missing --
 * explains why, gives a copyable install command, and lets the user
 * re-check without restarting the app. */
export function OcrMissingDialog({ open, onOpenChange, installHint, onAvailable }: OcrMissingDialogProps) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);

  async function copyCommand() {
    try {
      await copyTextToClipboard(installHint);
      toast.show({ kind: "success", title: "Copied to clipboard" });
    } catch (err) {
      toast.show({ kind: "error", title: "Copy failed", description: String(err) });
    }
  }

  async function checkAgain() {
    setChecking(true);
    try {
      const status = await ocrEngineStatus();
      if (status.available) {
        onOpenChange(false);
        onAvailable();
        toast.show({ kind: "success", title: "Tesseract found", description: "OCR is ready to use." });
      } else {
        toast.show({ kind: "error", title: "Still not found", description: "Run the install command, then try again." });
      }
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't check", description: String(err) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="OCR needs Tesseract"
      description="Text extraction and translation read text off the screen using Tesseract, which isn't installed. Install it, then check again."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="primary" icon={<RefreshCw size={14} />} loading={checking} onClick={checkAgain}>
            Check again
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2">
        <code className="flex-1 text-xs text-[var(--fg)] break-all">{installHint}</code>
        <Button variant="ghost" size="sm" iconOnly icon={<ClipboardCopy size={14} />} onClick={copyCommand} aria-label="Copy command" />
      </div>
    </Dialog>
  );
}
