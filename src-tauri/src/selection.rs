use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

use crate::commands::{CommandError, CommandResult};
use crate::geometry::{PhysPoint, PhysRect};
use crate::images::ImageStore;
use crate::session::CaptureSession;

const STORE_FILE: &str = "settings.json";
/// Deliberately its own store key rather than a `Settings` field: writing it
/// through `set_settings` would re-register every global shortcut and rebuild
/// the tray menu on each capture, which is both wasteful and a needless
/// contender for `HOTKEY_LOCK`.
const LAST_REGION_KEY: &str = "last_region";

/// Remembers the rect a capture was just confirmed at, so `RegionRepeat` can
/// re-shoot it later -- across restarts, hence the store rather than memory.
/// Best-effort: a failure here must not fail the capture that triggered it.
pub fn save_last_region(app: &AppHandle, rect: PhysRect) {
    let Ok(store) = app.store(STORE_FILE) else { return };
    if let Ok(value) = serde_json::to_value(rect) {
        store.set(LAST_REGION_KEY, value);
        let _ = store.save();
    }
}

pub fn load_last_region(app: &AppHandle) -> Option<PhysRect> {
    let store = app.store(STORE_FILE).ok()?;
    serde_json::from_value(store.get(LAST_REGION_KEY)?).ok()
}

#[derive(Default)]
pub struct SelectionState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    anchor: Option<PhysPoint>,
    current: Option<PhysPoint>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PointDto {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SelectionChanged {
    pub rect: Option<PhysRect>,
}

fn current_rect(inner: &Inner) -> Option<PhysRect> {
    match (inner.anchor, inner.current) {
        (Some(a), Some(b)) => Some(PhysRect::from_points(a, b)),
        _ => None,
    }
}

fn broadcast(app: &AppHandle, rect: Option<PhysRect>) {
    let _ = app.emit("selection:changed", SelectionChanged { rect });
}

/// Returns the resulting rect (in addition to broadcasting `selection:changed`)
/// so callers that need the authoritative value right away -- translation
/// mode's pointer-up handler, in particular -- don't have to wait on the
/// broadcast event, which can still be one frame behind the just-issued call.
#[tauri::command]
pub fn selection_begin(app: AppHandle, state: State<SelectionState>, point: PointDto) -> Option<PhysRect> {
    let mut inner = state.0.lock().unwrap();
    let p = PhysPoint::new(point.x, point.y);
    inner.anchor = Some(p);
    inner.current = Some(p);
    let rect = current_rect(&inner);
    drop(inner);
    broadcast(&app, rect);
    rect
}

#[tauri::command]
pub fn selection_update(app: AppHandle, state: State<SelectionState>, point: PointDto) -> Option<PhysRect> {
    let mut inner = state.0.lock().unwrap();
    inner.anchor?;
    inner.current = Some(PhysPoint::new(point.x, point.y));
    let rect = current_rect(&inner);
    drop(inner);
    broadcast(&app, rect);
    rect
}

#[tauri::command]
pub fn selection_end(app: AppHandle, state: State<SelectionState>, point: PointDto) -> Option<PhysRect> {
    selection_update(app, state, point)
}

/// Replaces the selection with an explicit rect, computed client-side by
/// dragging the selection body (move) or one of its resize handles. Stored
/// as anchor/current corners -- same representation `selection_begin`/
/// `selection_update` use -- so the rest of the selection lifecycle
/// (confirm, cancel, another draw gesture) doesn't need to know how the
/// rect got here.
#[tauri::command]
pub fn selection_set_rect(app: AppHandle, state: State<SelectionState>, rect: PhysRect) -> Option<PhysRect> {
    let mut inner = state.0.lock().unwrap();
    inner.anchor = Some(PhysPoint::new(rect.x, rect.y));
    inner.current = Some(PhysPoint::new(rect.right(), rect.bottom()));
    let out = current_rect(&inner);
    drop(inner);
    broadcast(&app, out);
    out
}

#[tauri::command]
pub fn selection_cancel(
    app: AppHandle,
    state: State<SelectionState>,
    main_was_visible: State<crate::commands::MainWasVisible>,
) {
    *state.0.lock().unwrap() = Inner::default();
    *app.state::<crate::cli::CliSink>().0.lock().unwrap() = None;
    *app.state::<crate::commands::QuicksaveSink>().0.lock().unwrap() = false;
    *app.state::<crate::commands::PostCaptureOverride>().0.lock().unwrap() = None;
    crate::overlay::close_overlays(&app);
    if *main_was_visible.0.lock().unwrap() {
        let _ = crate::commands::show_main_window(app);
    }
}

#[tauri::command]
pub async fn selection_confirm(
    app: AppHandle,
    state: State<'_, SelectionState>,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
) -> CommandResult<()> {
    let rect = {
        let inner = state.0.lock().unwrap();
        current_rect(&inner)
    };
    let Some(rect) = rect else {
        return Err(CommandError::Capture("no selection to confirm".into()));
    };
    selection_confirm_rect(app, session, images, rect).await
}

/// Confirms an explicit rect (used by window-pick mode, which selects a
/// window's rect on click rather than dragging).
pub async fn selection_confirm_rect(
    app: AppHandle,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
    rect: PhysRect,
) -> CommandResult<()> {
    let composited = {
        let guard = session.lock().unwrap();
        let session = guard.as_ref().ok_or(CommandError::NoSession)?;
        session.composite(rect)
    };
    *session.lock().unwrap() = None;
    *app.state::<SelectionState>().0.lock().unwrap() = Inner::default();
    save_last_region(&app, rect);

    crate::overlay::close_overlays(&app);

    let sink = app.state::<crate::cli::CliSink>().0.lock().unwrap().take();
    if let Some(output) = sink {
        let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
        return crate::cli::export_to_sink(&app, composited, &output, &settings);
    }

    let quicksave = std::mem::take(
        &mut *app
            .state::<crate::commands::QuicksaveSink>()
            .0
            .lock()
            .unwrap(),
    );
    if quicksave {
        let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
        let path = crate::export::quicksave_file(&settings);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| CommandError::Image(e.to_string()))?;
        }
        let png = crate::images::encode_png(&composited);
        std::fs::write(&path, &png).map_err(|e| CommandError::Image(e.to_string()))?;
        crate::export::notify_saved(&app, &path.to_string_lossy());
        return Ok(());
    }

    let image_id = images.insert(composited);
    crate::commands::deliver_capture(&app, image_id, rect).await
}

/// Confirms the current selection as a pin instead of an editor capture:
/// composites the rect, then opens a pin window positioned exactly over the
/// captured pixels (not centered/cursor-based like the editor's Pin action)
/// so the pin can be compared directly against what's underneath it.
#[tauri::command]
pub fn selection_confirm_pin(
    app: AppHandle,
    state: State<SelectionState>,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<ImageStore>,
) -> CommandResult<()> {
    let rect = {
        let inner = state.0.lock().unwrap();
        current_rect(&inner)
    };
    let Some(rect) = rect else {
        return Err(CommandError::Capture("no selection to confirm".into()));
    };

    let composited = {
        let guard = session.lock().unwrap();
        let session = guard.as_ref().ok_or(CommandError::NoSession)?;
        session.composite(rect)
    };
    let image_id = images.insert(composited);
    *session.lock().unwrap() = None;
    *state.0.lock().unwrap() = Inner::default();

    crate::overlay::close_overlays(&app);
    crate::pin::pin_image(&app, image_id, rect)
}

#[tauri::command]
pub async fn selection_confirm_window(
    app: AppHandle,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
    rect: PhysRect,
) -> CommandResult<()> {
    selection_confirm_rect(app, session, images, rect).await
}
