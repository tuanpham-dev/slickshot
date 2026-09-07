use std::path::{Path, PathBuf};

use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::commands::{CommandError, CommandResult};
use crate::images::ImageStore;

const STORE_FILE: &str = "history.json";
const STORE_KEY: &str = "captures";
/// Same cap upload history uses. Entries own files on disk, so eviction has
/// to delete those too -- see `remove_files`.
const MAX_HISTORY: usize = 100;
/// Longest side of the gallery thumbnail. Big enough to recognise a capture,
/// small enough that a hundred of them decode without a stutter.
const THUMB_MAX: u32 = 320;

/// What an entry holds. Defaulted to `Image` so an index written by any
/// build before recording existed still parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Image,
    Video,
}

fn default_kind() -> EntryKind {
    EntryKind::Image
}

/// One saved capture. The index carries only what the gallery needs to draw a
/// card; the pixels and any annotations live beside it on disk, keyed by `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    /// Where the user's own copy went, for "Show in folder". May since have
    /// been moved or deleted by the user -- the entry's own PNG is what
    /// reopening reads, so a stale path costs nothing but that one action.
    pub saved_path: String,
    pub width: u32,
    pub height: u32,
    pub has_shapes: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_kind")]
    pub kind: EntryKind,
    /// Recordings only: how long the clip runs, for the card's badge.
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

fn history_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Image(e.to_string()))?
        .join("history");
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(dir)
}

fn image_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.png"))
}

fn thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.thumb.png"))
}

fn shapes_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.shapes.json"))
}

pub(crate) fn video_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.mp4"))
}

/// Deletes every file an entry owns. Best-effort per file: a missing one is
/// the desired end state anyway, and one failure must not strand the others.
fn remove_files(dir: &Path, id: &str) {
    for path in [
        image_path(dir, id),
        thumb_path(dir, id),
        shapes_path(dir, id),
        video_path(dir, id),
    ] {
        let _ = std::fs::remove_file(path);
    }
}

fn now_iso() -> String {
    crate::upload::filename_timestamp_rfc3339()
}

fn read_index(app: &AppHandle) -> CommandResult<Vec<HistoryEntry>> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn write_index(app: &AppHandle, entries: &[HistoryEntry]) -> CommandResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    let value = serde_json::to_value(entries).map_err(|e| CommandError::Image(e.to_string()))?;
    store.set(STORE_KEY, value);
    store
        .save()
        .map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(())
}

/// Scales the longest side down to `THUMB_MAX`, leaving smaller images alone
/// so a tiny capture is not blurred by being scaled up.
pub(crate) fn thumbnail_of(image: &RgbaImage) -> RgbaImage {
    let (w, h) = image.dimensions();
    let longest = w.max(h);
    if longest <= THUMB_MAX {
        return image.clone();
    }
    let scale = THUMB_MAX as f32 / longest as f32;
    let tw = ((w as f32 * scale).round() as u32).max(1);
    let th = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(image, tw, th, image::imageops::FilterType::Triangle)
}

fn history_enabled(app: &AppHandle) -> bool {
    crate::settings::get_settings(app.clone())
        .map(|s| s.capture_history)
        .unwrap_or(true)
}

/// Writes an entry's files and inserts (or replaces) its index row.
///
/// `origin` names an existing entry to update in place, which is what keeps a
/// re-edited capture as one card rather than breeding a new one per save.
fn upsert(
    app: &AppHandle,
    origin: Option<String>,
    image: &RgbaImage,
    shapes_json: Option<&str>,
    saved_path: &str,
) -> CommandResult<()> {
    let dir = history_dir(app)?;
    let mut entries = read_index(app)?;

    let existing = origin.filter(|id| entries.iter().any(|e| &e.id == id));
    let id = existing
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    std::fs::write(image_path(&dir, &id), crate::images::encode_png(image))
        .map_err(|e| CommandError::Image(e.to_string()))?;
    std::fs::write(
        thumb_path(&dir, &id),
        crate::images::encode_png(&thumbnail_of(image)),
    )
    .map_err(|e| CommandError::Image(e.to_string()))?;

    // An entry re-saved without annotations must not keep the previous
    // pass's shapes, or reopening would resurrect them.
    match shapes_json.filter(|j| !j.is_empty()) {
        Some(json) => std::fs::write(shapes_path(&dir, &id), json)
            .map_err(|e| CommandError::Image(e.to_string()))?,
        None => {
            let _ = std::fs::remove_file(shapes_path(&dir, &id));
        }
    }

    let (width, height) = image.dimensions();
    let now = now_iso();
    let created_at = entries
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.created_at.clone())
        .unwrap_or_else(|| now.clone());
    let entry = HistoryEntry {
        id: id.clone(),
        saved_path: saved_path.to_string(),
        width,
        height,
        has_shapes: shapes_json.is_some_and(|j| !j.is_empty()),
        created_at,
        updated_at: now,
        kind: EntryKind::Image,
        duration_ms: None,
    };

    entries.retain(|e| e.id != id);
    entries.insert(0, entry);

    for evicted in evict(&mut entries, video_limit(app)) {
        remove_files(&dir, &evicted.id);
    }
    write_index(app, &entries)
}

fn video_limit(app: &AppHandle) -> usize {
    crate::settings::get_settings(app.clone())
        .map(|s| s.history_video_limit as usize)
        .unwrap_or(20)
}

/// Trims the index to its per-kind caps, returning what was dropped.
///
/// Counted separately because the two kinds cost wildly different amounts of
/// disk: a hundred PNGs is a few hundred megabytes, a hundred MP4s is
/// several gigabytes. One shared cap would let a run of recordings evict
/// every screenshot the user had kept, or vice versa.
fn evict(entries: &mut Vec<HistoryEntry>, video_limit: usize) -> Vec<HistoryEntry> {
    let (mut images, mut videos) = (0usize, 0usize);
    let mut dropped = Vec::new();
    entries.retain(|e| {
        let (count, limit) = match e.kind {
            EntryKind::Image => (&mut images, MAX_HISTORY),
            EntryKind::Video => (&mut videos, video_limit),
        };
        *count += 1;
        if *count > limit {
            dropped.push(e.clone());
            false
        } else {
            true
        }
    });
    dropped
}

/// Records a capture that was written straight to a file with no annotation
/// pass -- quicksave, auto-save, the overlay's Save button, the CLI's `-o`.
///
/// Best-effort by design: history is a convenience, and a failure here must
/// never fail the save the user actually asked for.
pub fn record_saved_file(app: &AppHandle, image: &RgbaImage, saved_path: &str) {
    if !history_enabled(app) {
        return;
    }
    if let Err(e) = upsert(app, None, image, None, saved_path) {
        eprintln!("[history] couldn't record {saved_path}: {e}");
    }
}

/// Records a recording the user kept. The MP4 is copied into the history
/// directory rather than referenced in place, for the same reason images are:
/// the copy in the save folder is the user's to move or delete, and reopening
/// an entry has to keep working when they do.
///
/// Best-effort, like `record_saved_file` -- a history failure must not fail
/// the save itself.
pub fn record_saved_video(app: &AppHandle, saved_path: &Path) {
    if !history_enabled(app) {
        return;
    }
    if let Err(e) = upsert_video(app, saved_path) {
        eprintln!("[history] couldn't record {}: {e}", saved_path.display());
    }
}

fn upsert_video(app: &AppHandle, saved_path: &Path) -> CommandResult<()> {
    let dir = history_dir(app)?;
    let mut entries = read_index(app)?;
    let id = uuid::Uuid::new_v4().to_string();

    let backend = crate::record::default_backend();
    let info = backend
        .probe(saved_path)
        .map_err(|e| CommandError::Image(e.to_string()))?;

    std::fs::copy(saved_path, video_path(&dir, &id))
        .map_err(|e| CommandError::Image(e.to_string()))?;
    // A poster is what makes the card recognisable; a recording without one
    // is still worth keeping, so this failing is not fatal.
    if let Err(e) = backend.poster(saved_path, &thumb_path(&dir, &id)) {
        eprintln!("[history] no thumbnail for {}: {e}", saved_path.display());
    }

    let now = now_iso();
    entries.insert(
        0,
        HistoryEntry {
            id,
            saved_path: saved_path.to_string_lossy().into_owned(),
            width: info.width,
            height: info.height,
            has_shapes: false,
            created_at: now.clone(),
            updated_at: now,
            kind: EntryKind::Video,
            duration_ms: Some(info.duration_ms),
        },
    );

    for evicted in evict(&mut entries, video_limit(app)) {
        remove_files(&dir, &evicted.id);
    }
    write_index(app, &entries)
}

/// Records an export from the editor, keeping the base image and the shapes
/// separately so the entry reopens re-editable. Updates the originating entry
/// when this capture came from history.
pub fn record_editor_save(app: &AppHandle, shapes_json: Option<&str>, saved_path: &str) {
    if !history_enabled(app) {
        return;
    }
    let Some(image_id) = app.state::<crate::editor::EditorImage>().0.lock().unwrap().clone() else {
        return;
    };
    let Some(image) = app.state::<ImageStore>().get(&image_id) else {
        return;
    };
    let origin = app
        .state::<crate::editor::HistoryOrigin>()
        .0
        .lock()
        .unwrap()
        .clone();
    if let Err(e) = upsert(app, origin, image.as_ref(), shapes_json, saved_path) {
        eprintln!("[history] couldn't record {saved_path}: {e}");
    }
}

#[tauri::command]
pub fn history_list(app: AppHandle) -> CommandResult<Vec<HistoryEntry>> {
    read_index(&app)
}

/// Thumbnail bytes for the gallery. Read through a command rather than the
/// `slickshot://` protocol because these live on disk rather than in
/// `ImageStore`, and the gallery wants them without loading full captures.
#[tauri::command]
pub fn history_thumb(app: AppHandle, id: String) -> CommandResult<Vec<u8>> {
    let dir = history_dir(&app)?;
    std::fs::read(thumb_path(&dir, &id)).map_err(|e| CommandError::Image(e.to_string()))
}

/// Puts an entry's image on the clipboard. Reads the entry's own PNG rather
/// than the user's saved copy, which may have been moved or re-encoded.
#[tauri::command]
pub fn history_copy(app: AppHandle, id: String) -> CommandResult<()> {
    let dir = history_dir(&app)?;
    let bytes = std::fs::read(image_path(&dir, &id))
        .map_err(|e| CommandError::Image(format!("this capture's file is gone: {e}")))?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_rgba8();
    crate::export::copy_image_to_clipboard(image)
}

#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> CommandResult<()> {
    let dir = history_dir(&app)?;
    let mut entries = read_index(&app)?;
    entries.retain(|e| e.id != id);
    remove_files(&dir, &id);
    write_index(&app, &entries)
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> CommandResult<()> {
    let dir = history_dir(&app)?;
    for entry in read_index(&app)? {
        remove_files(&dir, &entry.id);
    }
    write_index(&app, &[])
}

/// Opens an entry in the editor: its base image becomes the editor's image
/// and its shapes are parked for the editor to drain, so the annotations
/// arrive selectable rather than baked in.
#[tauri::command]
pub async fn history_open_in_editor(app: AppHandle, id: String) -> CommandResult<()> {
    let dir = history_dir(&app)?;

    // Recordings open in their own editor, and carry no shapes to restore --
    // annotations on a video are applied at export, not stored with it.
    let is_video = read_index(&app)?
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.kind == EntryKind::Video)
        .unwrap_or(false);
    if is_video {
        let path = video_path(&dir, &id);
        if !path.exists() {
            return Err(CommandError::Image(
                "this recording's file is gone".into(),
            ));
        }
        return crate::video::open_editor(&app, &path).await;
    }

    let bytes = std::fs::read(image_path(&dir, &id))
        .map_err(|e| CommandError::Image(format!("this capture's file is gone: {e}")))?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_rgba8();
    let shapes = std::fs::read_to_string(shapes_path(&dir, &id)).unwrap_or_default();

    *app.state::<crate::editor::PendingEditorShapes>()
        .0
        .lock()
        .unwrap() = shapes;
    let image_id = app.state::<ImageStore>().insert(image);
    crate::editor::show(&app, &image_id).await?;
    // Set after `show`, which clears the origin for fresh captures -- this
    // one is deliberately *not* fresh, so saving it updates this entry.
    *app.state::<crate::editor::HistoryOrigin>().0.lock().unwrap() = Some(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba([10, 20, 30, 255]))
    }

    fn entry(id: &str, kind: EntryKind) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            saved_path: format!("/tmp/{id}"),
            width: 100,
            height: 100,
            has_shapes: false,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            kind,
            duration_ms: None,
        }
    }

    /// The two kinds are capped separately, so a run of recordings can't
    /// evict screenshots the user meant to keep (or the reverse).
    #[test]
    fn videos_evict_against_their_own_limit() {
        let mut entries: Vec<HistoryEntry> = (0..21)
            .map(|i| entry(&format!("v{i}"), EntryKind::Video))
            .chain((0..5).map(|i| entry(&format!("i{i}"), EntryKind::Image)))
            .collect();

        let dropped = evict(&mut entries, 20);

        assert_eq!(dropped.len(), 1, "one video over the limit");
        assert_eq!(dropped[0].id, "v20", "the oldest video goes");
        assert_eq!(
            entries.iter().filter(|e| e.kind == EntryKind::Image).count(),
            5,
            "no image is touched"
        );
        assert_eq!(entries.iter().filter(|e| e.kind == EntryKind::Video).count(), 20);
    }

    #[test]
    fn images_still_evict_at_their_own_cap() {
        let mut entries: Vec<HistoryEntry> = (0..MAX_HISTORY + 3)
            .map(|i| entry(&format!("i{i}"), EntryKind::Image))
            .collect();
        let dropped = evict(&mut entries, 20);
        assert_eq!(dropped.len(), 3);
        assert_eq!(entries.len(), MAX_HISTORY);
    }

    /// An index written before recording existed has no `kind` field at all.
    #[test]
    fn an_entry_without_a_kind_reads_as_an_image() {
        let row = serde_json::json!({
            "id": "abc",
            "saved_path": "/tmp/a.png",
            "width": 100,
            "height": 80,
            "has_shapes": false,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        });
        let entry: HistoryEntry = serde_json::from_value(row).expect("must still deserialize");
        assert_eq!(entry.kind, EntryKind::Image);
        assert!(entry.duration_ms.is_none());
    }

    #[test]
    fn thumbnail_scales_the_longest_side_down() {
        let thumb = thumbnail_of(&solid(1600, 900));
        assert_eq!(thumb.width(), THUMB_MAX);
        assert_eq!(thumb.height(), 180);
    }

    #[test]
    fn thumbnail_leaves_a_small_capture_alone() {
        // Scaling up would only blur it, and the gallery renders it at its
        // own size anyway.
        let thumb = thumbnail_of(&solid(120, 80));
        assert_eq!(thumb.dimensions(), (120, 80));
    }

    #[test]
    fn thumbnail_keeps_a_tall_capture_within_the_cap() {
        let thumb = thumbnail_of(&solid(400, 4000));
        assert_eq!(thumb.height(), THUMB_MAX);
        assert_eq!(thumb.width(), 32);
    }
}
