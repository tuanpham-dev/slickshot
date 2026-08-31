import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, FolderOpen, ImageOff, Images, Pencil, Trash2 } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ConfirmDialog } from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import {
  historyClear,
  historyCopy,
  historyDelete,
  historyList,
  historyOpenInEditor,
  historyThumbUrl,
  type HistoryEntry,
} from "../lib/ipc";

function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** Thumbnails live on disk rather than at a URL, so each one is fetched as
 * bytes and held as an object URL for as long as the card is mounted. */
function Thumbnail({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    historyThumbUrl(id)
      .then((u) => {
        revoked = u;
        setUrl(u);
      })
      .catch(() => setFailed(true));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id]);

  if (failed) {
    return (
      <div className="flex items-center justify-center w-14 h-14 shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg-subtle)]">
        <ImageOff size={16} />
      </div>
    );
  }
  return (
    <div className="w-14 h-14 shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
      {url && <img src={url} alt="" className="w-full h-full object-cover" />}
    </div>
  );
}

export function CaptureHistory() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HistoryEntry | null>(null);
  const toast = useToast();

  useEffect(() => {
    historyList()
      .then(setEntries)
      .catch((err) =>
        toast.show({ kind: "error", title: "Couldn't load capture history", description: String(err) }),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpen(entry: HistoryEntry) {
    try {
      await historyOpenInEditor(entry.id);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't open this capture", description: String(err) });
    }
  }

  async function handleCopy(entry: HistoryEntry) {
    try {
      await historyCopy(entry.id);
      toast.show({ kind: "success", title: "Copied to clipboard" });
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't copy this capture", description: String(err) });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    try {
      await historyDelete(id);
      setEntries((prev) => (prev ?? []).filter((e) => e.id !== id));
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't delete this capture", description: String(err) });
    }
  }

  async function handleClear() {
    try {
      await historyClear();
      setEntries([]);
    } catch (err) {
      toast.show({ kind: "error", title: "Couldn't clear history", description: String(err) });
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
        {entries === null ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-[var(--fg-muted)]">Loading…</span>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Images size={28} />}
            title="No captures yet"
            description="Screenshots you save show up here, ready to reopen with their annotations."
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
              >
                <Thumbnail id={entry.id} />
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-[var(--fg)] truncate">
                    {entry.saved_path.split("/").pop()}
                  </span>
                  <span className="text-[10px] text-[var(--fg-muted)]">
                    {entry.width} × {entry.height} · {formatSavedAt(entry.updated_at)}
                    {entry.has_shapes ? " · annotated" : ""}
                  </span>
                </div>
                <IconButton
                  label="Open in editor"
                  icon={<Pencil size={14} />}
                  onClick={() => handleOpen(entry)}
                />
                <IconButton
                  label="Copy image"
                  icon={<Copy size={14} />}
                  onClick={() => handleCopy(entry)}
                />
                <IconButton
                  label="Show in folder"
                  icon={<FolderOpen size={14} />}
                  onClick={() => revealItemInDir(entry.saved_path)}
                />
                <IconButton
                  label="Delete"
                  icon={<Trash2 size={14} />}
                  onClick={() => setDeleteTarget(entry)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {entries !== null && entries.length > 0 && (
        <div className="px-4 pb-4 pt-2">
          <div className="flex items-center justify-between border-t border-[var(--border)] pt-3">
            <span className="text-xs text-[var(--fg-muted)]">
              {entries.length} capture{entries.length === 1 ? "" : "s"}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
              Clear history
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Clear capture history?"
        description="Forgets every entry and deletes the copies SlickShot keeps. The screenshots you saved yourself are left alone."
        confirmLabel="Clear"
        onConfirm={handleClear}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this capture?"
        description="Removes it from history and deletes SlickShot's copy. Your own saved file is left alone."
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </>
  );
}
