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

/// Where a confirmed capture goes. The overlay's action cluster offers Copy
/// and Save alongside the plain confirm, which keeps meaning "whatever
/// `post_capture` is configured to do".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfirmDest {
    #[default]
    Default,
    Copy,
    Save,
}

/// A one-shot destination for the next confirm, set by the overlay just
/// before it confirms. Carried as state rather than an argument because the
/// annotated path's request body is raw PNG bytes and cannot also hold JSON;
/// one mechanism serving both paths beats two that can drift. Taken (not
/// read) on use, and cleared on cancel and on every new capture.
#[derive(Default)]
pub struct ConfirmDestOverride(pub Mutex<Option<ConfirmDest>>);

#[tauri::command]
pub fn selection_set_dest(state: State<ConfirmDestOverride>, dest: ConfirmDest) {
    *state.0.lock().unwrap() = Some(dest);
}

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

/// Drops the live selection without the rest of `selection_cancel`'s teardown
/// (overlay closing, sink clearing). For flows that take the overlay down
/// themselves and then keep going, like scrolling capture.
pub fn clear_selection(app: &AppHandle) {
    *app.state::<SelectionState>().0.lock().unwrap() = Inner::default();
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
    *app.state::<crate::commands::AutoSaveOverride>().0.lock().unwrap() = None;
    app.state::<crate::commands::OverlayShapes>().0.lock().unwrap().clear();
    *app.state::<ConfirmDestOverride>().0.lock().unwrap() = None;
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

/// Composites the current selection into the image store and returns its id,
/// leaving the capture session intact.
///
/// The overlay needs these exact pixels to flatten annotations over, and
/// cannot produce them itself: a selection can span monitors while each
/// overlay window holds only its own monitor's frozen frame. The caller is
/// expected to `release_image` the id once it has drawn from it.
#[tauri::command]
pub fn selection_region_image(
    state: State<SelectionState>,
    session: State<Mutex<Option<CaptureSession>>>,
    images: State<ImageStore>,
) -> CommandResult<String> {
    let rect = {
        let inner = state.0.lock().unwrap();
        current_rect(&inner)
    };
    let Some(rect) = rect else {
        return Err(CommandError::Capture("no selection".into()));
    };
    let guard = session.lock().unwrap();
    let session = guard.as_ref().ok_or(CommandError::NoSession)?;
    Ok(images.insert(session.composite(rect)))
}

/// Confirms a capture the overlay has already flattened: the region plus its
/// annotations, encoded as PNG in the raw request body. Everything after the
/// pixels exist is shared with the un-annotated path, so post-capture routing,
/// quicksave and the CLI sink behave identically.
///
/// The rect comes from `SelectionState` rather than the request: Tauri's raw
/// body carries bytes only, and the state already holds the authoritative
/// selection. The bytes are checked against it, so a mismatch fails loudly
/// instead of writing a capture that does not match the region confirmed.
#[tauri::command]
pub async fn selection_confirm_annotated(
    app: AppHandle,
    state: State<'_, SelectionState>,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<()> {
    let rect = {
        let inner = state.0.lock().unwrap();
        current_rect(&inner)
    };
    let Some(rect) = rect else {
        return Err(CommandError::Capture("no selection to confirm".into()));
    };
    let flattened = decode_png_body(&request)?;
    if flattened.dimensions() != (rect.w, rect.h) {
        return Err(CommandError::Image(format!(
            "annotated capture is {}x{} but the selection is {}x{}",
            flattened.width(),
            flattened.height(),
            rect.w,
            rect.h
        )));
    }
    finish_confirm(app, session, images, rect, flattened).await
}

/// Opens the editor on the *clean* region, parking the overlay's annotations
/// for it to pick up -- so they arrive as editable shapes rather than baked
/// pixels. Bypasses `deliver_capture`: "Edit" means the editor whatever the
/// configured post-capture action is.
#[tauri::command]
pub async fn selection_confirm_to_editor(
    app: AppHandle,
    state: State<'_, SelectionState>,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
    shapes_json: String,
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
    *session.lock().unwrap() = None;
    *app.state::<SelectionState>().0.lock().unwrap() = Inner::default();
    save_last_region(&app, rect);
    crate::overlay::close_overlays(&app);

    // Stored before the editor is told about the image: it drains this right
    // after the image loads, and an empty string means "no annotations".
    *app.state::<crate::editor::PendingEditorShapes>()
        .0
        .lock()
        .unwrap() = shapes_json;

    let image_id = images.insert(composited);
    crate::editor::show(&app, &image_id).await
}

fn decode_png_body(request: &tauri::ipc::Request<'_>) -> CommandResult<image::RgbaImage> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "selection_confirm_annotated expects a raw binary body, not JSON".into(),
            ))
        }
    };
    Ok(
        image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .map_err(|e| CommandError::Image(e.to_string()))?
            .to_rgba8(),
    )
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
    finish_confirm(app, session, images, rect, composited).await
}

/// Everything a confirmed region goes through once its pixels exist: tear
/// down the session, remember the rect, close the overlays, then route the
/// image (CLI sink -> quicksave -> `deliver_capture`). Split out so an
/// annotated capture, whose pixels are flattened in the webview rather than
/// composited here, takes the identical path.
async fn finish_confirm(
    app: AppHandle,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
    rect: PhysRect,
    composited: image::RgbaImage,
) -> CommandResult<()> {
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
        crate::history::record_saved_file(&app, &composited, &path.to_string_lossy());
        return Ok(());
    }

    let dest = app
        .state::<ConfirmDestOverride>()
        .0
        .lock()
        .unwrap()
        .take()
        .unwrap_or_default();
    match dest {
        // Copy and Save are complete destinations: neither runs the
        // configured post-capture action on top of what was asked for.
        ConfirmDest::Copy => crate::export::copy_image_to_clipboard(composited),
        // Same writer, notification included, that keeps a capture nobody
        // opened -- Save is just that on purpose rather than as a fallback.
        ConfirmDest::Save => crate::export::autosave_image(&app, &composited).map(|_| ()),
        ConfirmDest::Default => {
            let image_id = images.insert(composited);
            crate::commands::deliver_capture(&app, image_id, rect).await
        }
    }
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
