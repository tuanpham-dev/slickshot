import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Download, FolderOpen, Trash2, Upload } from "lucide-react";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import {
  onVideoExportProgress,
  videoCopyFile,
  videoExport,
  videoExportPrepare,
  videoUpload,
  videoUploadSupported,
  type VideoExportRequest,
} from "../lib/ipc";

/** No overlay to burn in yet -- annotations land in Phase 4. The raw body is
 * still what `video_export` expects, so an empty one says "nothing on top". */
const NO_OVERLAY = new Uint8Array(0);

export interface VideoExportBarProps {
  /** Everything but the destination, which each button supplies. */
  request: Omit<VideoExportRequest, "dest">;
  onDiscard: () => void;
  onReveal: () => void;
}

/** Save As / Quick save / Copy file / Upload / Discard, and the progress the
 * encode reports while any of them runs.
 *
 * Deliberately mirrors the image editor's export row: the same verbs in the
 * same order, so the two editors do not have to be learned separately. */
export function VideoExportBar({ request, onDiscard, onReveal }: VideoExportBarProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [canUpload, setCanUpload] = useState(false);

  useEffect(() => {
    videoUploadSupported()
      .then(setCanUpload)
      // A provider we cannot ask about is one we should not offer.
      .catch(() => setCanUpload(false));
  }, []);

  useEffect(() => {
    const unlisten = onVideoExportProgress(({ done, total }) => {
      setProgress(total > 0 ? Math.min(1, done / total) : null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function run(label: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setProgress(0);
    try {
      await work();
    } catch (err) {
      toast.show({ kind: "error", title: `Couldn't ${label.toLowerCase()}`, description: String(err) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const handleSaveAs = () =>
    run("Save", async () => {
      const isGif = request.format === "gif";
      const path = await saveDialog({
        defaultPath: isGif ? "Recording.gif" : "Recording.mp4",
        filters: isGif
          ? [{ name: "GIF", extensions: ["gif"] }]
          : [{ name: "MP4 video", extensions: ["mp4"] }],
      });
      // A cancelled dialog is not a failure -- just nothing to do.
      if (!path) return;
      await videoExportPrepare({ ...request, dest: { kind: "path", path } });
      const { saved_path } = await videoExport(NO_OVERLAY);
      toast.show({ kind: "success", title: "Saved", description: saved_path });
    });

  const handleQuickSave = () =>
    run("Quick save", async () => {
      await videoExportPrepare({ ...request, dest: { kind: "quicksave" } });
      const { saved_path } = await videoExport(NO_OVERLAY);
      toast.show({ kind: "success", title: "Saved", description: saved_path });
    });

  const handleCopyFile = () =>
    run("Copy file", async () => {
      await videoExportPrepare({ ...request, dest: { kind: "quicksave" } });
      await videoCopyFile();
      toast.show({
        kind: "success",
        title: "Copied",
        description: "Paste into Finder or a message to attach the recording.",
      });
    });

  const handleUpload = () =>
    run("Upload", async () => {
      await videoExportPrepare({ ...request, format: "mp4", dest: { kind: "quicksave" } });
      const result = await videoUpload();
      await navigator.clipboard.writeText(result.url).catch(() => {});
      toast.show({
        kind: "success",
        title: "Uploaded",
        description: `${result.url} (copied)`,
      });
    });

  return (
    <div className="relative flex items-center justify-end gap-2 px-3 h-12 border-t border-[var(--border)] bg-[var(--surface)]">
      {progress !== null && (
        <div
          className="absolute left-0 top-0 h-0.5 bg-[var(--accent)] transition-[width] duration-150"
          style={{ width: `${Math.round(progress * 100)}%` }}
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Export progress"
        />
      )}

      <Button
        variant="secondary"
        size="sm"
        icon={<FolderOpen size={14} />}
        onClick={onReveal}
        disabled={!!busy}
      >
        Show in folder
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<Copy size={14} />}
        onClick={handleCopyFile}
        disabled={!!busy}
      >
        Copy file
      </Button>
      {canUpload && (
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={14} />}
          onClick={handleUpload}
          disabled={!!busy}
        >
          {busy === "Upload" ? "Uploading…" : "Upload"}
        </Button>
      )}
      <Button
        variant="secondary"
        size="sm"
        icon={<Trash2 size={14} />}
        onClick={onDiscard}
        disabled={!!busy}
      >
        Discard
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<Download size={14} />}
        onClick={handleSaveAs}
        disabled={!!busy}
      >
        Save As…
      </Button>
      <Button variant="primary" size="sm" onClick={handleQuickSave} disabled={!!busy}>
        {busy === "Quick save" ? "Saving…" : "Quick save"}
      </Button>
    </div>
  );
}
