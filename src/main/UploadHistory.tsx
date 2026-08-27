import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Copy, ExternalLink, ImageOff, Trash2, UploadCloud } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ConfirmDialog } from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import { uploadHistory, uploadHistoryClear, uploadDelete, copyTextToClipboard, type UploadEntry } from "../lib/ipc";

function formatUploadedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** The upload URL itself is a direct image link for every provider
 * (catbox/Imgur/0x0.st), so it doubles as the thumbnail source -- no local
 * copy needs to be kept. Falls back to a broken-image icon once a link has
 * expired (0x0.st) or otherwise stops resolving. */
function Thumbnail({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="flex items-center justify-center w-10 h-10 shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg-subtle)]">
        <ImageOff size={16} />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      className="w-10 h-10 shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] object-cover bg-[var(--surface-2)]"
    />
  );
}

export function UploadHistory({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<UploadEntry[] | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UploadEntry | null>(null);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    uploadHistory()
      .then(setEntries)
      .catch((err) => toast.show({ kind: "error", title: "Couldn't load upload history", description: String(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCopy(url: string) {
    await copyTextToClipboard(url);
    toast.show({ kind: "success", title: "Link copied" });
  }

  async function handleClear() {
    try {
      await uploadHistoryClear();
      setEntries([]);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't clear history", description: String(err) });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const url = deleteTarget.url;
    setDeletingUrl(url);
    try {
      const remaining = await uploadDelete(url);
      setEntries(remaining);
      toast.show({ kind: "success", title: "Deleted from Imgur" });
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't delete upload", description: String(err) });
    } finally {
      setDeletingUrl(null);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg)]">
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <IconButton label="Back" icon={<ArrowLeft size={16} />} onClick={onBack} />
        <h1 className="text-sm font-semibold text-[var(--fg)]">Uploads</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
        {entries === null ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-[var(--fg-muted)]">Loading…</span>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<UploadCloud size={28} />}
            title="No uploads yet"
            description="Uploaded screenshots will show up here with a copyable link."
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {entries.map((entry, i) => (
              <div
                key={`${entry.url}-${i}`}
                className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <Thumbnail url={entry.url} />
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-xs font-mono text-[var(--fg)] truncate">{entry.url}</span>
                  <span className="text-[10px] text-[var(--fg-muted)]">
                    {entry.provider} · {formatUploadedAt(entry.uploaded_at)}
                  </span>
                </div>
                <IconButton label="Copy link" icon={<Copy size={14} />} onClick={() => handleCopy(entry.url)} />
                <IconButton label="Open link" icon={<ExternalLink size={14} />} onClick={() => openUrl(entry.url)} />
                {entry.delete_url && (
                  <IconButton
                    label="Delete from Imgur"
                    icon={<Trash2 size={14} />}
                    disabled={deletingUrl === entry.url}
                    onClick={() => setDeleteTarget(entry)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {entries !== null && entries.length > 0 && (
        <div className="px-4 pb-4 pt-2">
          <div className="flex items-center justify-between border-t border-[var(--border)] pt-3">
            <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
              Clear history
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Clear upload history?"
        description="This removes the local record of past uploads. It doesn't delete the files from the host."
        confirmLabel="Clear"
        danger
        onConfirm={handleClear}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete from Imgur?"
        description="This removes the image from Imgur permanently."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
      />
    </div>
  );
}
