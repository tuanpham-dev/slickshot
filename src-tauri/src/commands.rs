use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, State};

use crate::capture::{MonitorInfo, ScreenCapturer, WindowInfo};
use crate::images::ImageStore;
use crate::session::CaptureSession;

pub struct Capturer(pub Box<dyn ScreenCapturer>);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    Screen,
    Monitor,
    Region,
    /// Re-shoots the last confirmed region without showing an overlay.
    #[serde(rename = "region_repeat")]
    RegionRepeat,
    Window,
    Translate,
    /// Pick a pixel's color off the frozen frame.
    Color,
    /// Measure a distance on the frozen frame.
    Measure,
}

/// Whether the main window was visible right before the most recent capture
/// hid it. `selection::selection_cancel` re-shows the main window only when
/// this is true, so dismissing a hotkey-triggered capture (main window
/// already hidden) doesn't unexpectedly pop it up.
#[derive(Default)]
pub struct MainWasVisible(pub Mutex<bool>);

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("capture failed: {0}")]
    Capture(String),
    #[error("no active capture session")]
    NoSession,
    #[error("window error: {0}")]
    Window(String),
    #[error("image error: {0}")]
    Image(String),
}

pub type CommandResult<T> = Result<T, CommandError>;

#[tauri::command]
pub fn list_monitors(capturer: State<Capturer>) -> CommandResult<Vec<MonitorInfo>> {
    capturer
        .0
        .monitors()
        .map_err(|e| CommandError::Capture(e.to_string()))
}

#[tauri::command]
pub fn list_windows(capturer: State<Capturer>) -> CommandResult<Vec<WindowInfo>> {
    capturer
        .0
        .windows()
        .map_err(|e| CommandError::Capture(e.to_string()))
}

async fn hide_and_wait(app: &AppHandle, delay_ms: u32) -> CommandResult<()> {
    let mut any_was_visible = false;
    for (_, window) in app.webview_windows() {
        if window.is_visible().unwrap_or(false) {
            any_was_visible = true;
            let _ = window.hide();
        }
    }
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms as u64)).await;
    } else if any_was_visible {
        // give the compositor a moment to actually hide windows before
        // grabbing pixels; skipped entirely when nothing was visible
        // (hotkey capture with the main window already hidden)
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    capturer: State<'_, Capturer>,
    session: State<'_, Mutex<Option<CaptureSession>>>,
    images: State<'_, ImageStore>,
    mode: CaptureMode,
    delay_ms: u32,
    target_id: Option<u32>,
) -> CommandResult<()> {
    run_capture(
        &app,
        capturer.inner(),
        session.inner(),
        images.inner(),
        mode,
        delay_ms,
        target_id,
    )
    .await
}

/// Shared by the `start_capture` command and the global-hotkey handlers,
/// which can't use Tauri's command-parameter state injection since they
/// aren't invoked through IPC.
pub async fn run_capture(
    app: &AppHandle,
    capturer: &Capturer,
    session: &Mutex<Option<CaptureSession>>,
    images: &ImageStore,
    mode: CaptureMode,
    delay_ms: u32,
    target_id: Option<u32>,
) -> CommandResult<()> {
    let app = app.clone();

    let main_visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    *app.state::<MainWasVisible>().0.lock().unwrap() = main_visible;

    hide_and_wait(&app, delay_ms).await?;

    match mode {
        CaptureMode::Screen => {
            let grabbed = CaptureSession::grab(capturer.0.as_ref())
                .map_err(|e| CommandError::Capture(e.to_string()))?;
            let rect = grabbed.virtual_rect;
            let composited = grabbed.composite(rect);
            let image_id = images.insert(composited);
            *session.lock().unwrap() = None;
            crate::editor::show(&app, &image_id).await?;
        }
        CaptureMode::Monitor => {
            let id = target_id.ok_or_else(|| {
                CommandError::Capture("monitor mode requires target_id".into())
            })?;
            let grabbed = CaptureSession::grab(capturer.0.as_ref())
                .map_err(|e| CommandError::Capture(e.to_string()))?;
            let frame = grabbed
                .frame_for_monitor(id)
                .ok_or_else(|| CommandError::Capture(format!("no monitor with id {id}")))?;
            let image_id = images.insert_arc(frame.image.clone());
            *session.lock().unwrap() = None;
            crate::editor::show(&app, &image_id).await?;
        }
        CaptureMode::RegionRepeat => {
            let grabbed = CaptureSession::grab(capturer.0.as_ref())
                .map_err(|e| CommandError::Capture(e.to_string()))?;
            // The stored rect can be stale after a monitor is unplugged or
            // rearranged, so it's intersected with the current virtual
            // screen. No stored rect (or nothing left of it) falls back to a
            // normal region selection rather than failing the hotkey.
            let repeat = crate::selection::load_last_region(&app)
                .and_then(|rect| rect.intersect(&grabbed.virtual_rect));
            match repeat {
                Some(rect) => {
                    let composited = grabbed.composite(rect);
                    let image_id = images.insert(composited);
                    *session.lock().unwrap() = None;
                    crate::editor::show(&app, &image_id).await?;
                }
                None => {
                    *session.lock().unwrap() = Some(grabbed);
                    crate::overlay::open_overlays(&app, CaptureMode::Region)
                        .await
                        .map_err(|e| CommandError::Window(e.to_string()))?;
                    return Ok(());
                }
            }
        }
        CaptureMode::Region
        | CaptureMode::Window
        | CaptureMode::Translate
        | CaptureMode::Color
        | CaptureMode::Measure => {
            let grabbed = CaptureSession::grab(capturer.0.as_ref())
                .map_err(|e| CommandError::Capture(e.to_string()))?;
            *session.lock().unwrap() = Some(grabbed);
            crate::overlay::open_overlays(&app, mode)
                .await
                .map_err(|e| CommandError::Window(e.to_string()))?;
        }
    }

    if !matches!(
        mode,
        CaptureMode::Region
            | CaptureMode::Window
            | CaptureMode::Translate
            | CaptureMode::Color
            | CaptureMode::Measure
    ) {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
    }

    Ok(())
}

// Genuinely async (unlike this file's other commands, which use
// `tauri::async_runtime::block_on` for the same `editor::show` call): this
// one is also invoked directly from `cli::spawn_open`, which runs inside a
// `tauri::async_runtime::spawn` task -- `block_on`-ing there would nest a
// blocking wait inside the async runtime's own worker thread.
#[tauri::command]
pub async fn open_image_file(
    app: AppHandle,
    images: State<'_, ImageStore>,
    path: String,
) -> CommandResult<()> {
    let img = image::open(&path)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_rgba8();
    let image_id = images.insert(img);
    crate::editor::show(&app, &image_id).await
}

/// Loads an image file into the store and returns its id *without* opening
/// the editor -- for pulling a picture into the current annotation session
/// (Insert image) rather than replacing what's being edited. The caller
/// fetches the pixels over `slickshot://` and should `release_image` afterwards.
#[tauri::command]
pub fn load_image_file(images: State<ImageStore>, path: String) -> CommandResult<String> {
    let img = image::open(&path)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_rgba8();
    Ok(images.insert(img))
}

/// Reads an image off the system clipboard into the store, returning its id,
/// or `None` when the clipboard holds no image.
///
/// The webview can't do this itself: WebKitGTK only fires `paste` events at
/// an editable target, so a Ctrl+V over the canvas never reaches the page --
/// the same class of Linux clipboard gap that already forces the *copy* path
/// through `arboard` rather than `navigator.clipboard`.
#[tauri::command]
pub fn read_clipboard_image(images: State<ImageStore>) -> CommandResult<Option<String>> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| CommandError::Image(e.to_string()))?;
    // An error here overwhelmingly means "no image on the clipboard" (text,
    // empty, or an unsupported flavor), which is a normal Ctrl+V, not a
    // failure worth surfacing to the user.
    let Ok(image) = clipboard.get_image() else {
        return Ok(None);
    };
    let (width, height) = (image.width as u32, image.height as u32);
    let Some(rgba) = image::RgbaImage::from_raw(width, height, image.bytes.into_owned()) else {
        return Err(CommandError::Image(
            "clipboard image had unexpected dimensions".into(),
        ));
    };
    Ok(Some(images.insert(rgba)))
}

/// Drops a stored image. Unknown ids are ignored: releasing twice (or
/// releasing after the store was cleared) is not an error worth surfacing.
#[tauri::command]
pub fn release_image(images: State<ImageStore>, image_id: String) -> CommandResult<()> {
    images.remove(&image_id);
    Ok(())
}

#[tauri::command]
pub async fn open_editor(app: AppHandle, images: State<'_, ImageStore>, image_id: String) -> CommandResult<()> {
    if images.get(&image_id).is_none() {
        return Err(CommandError::Image(format!("unknown image id {image_id}")));
    }
    crate::editor::show(&app, &image_id).await
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> CommandResult<()> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn cursor_physical_position(app: AppHandle) -> CommandResult<PhysicalPosition<f64>> {
    let window = app
        .webview_windows()
        .values()
        .next()
        .cloned()
        .ok_or_else(|| CommandError::Window("no window available to query cursor".into()))?;
    window
        .cursor_position()
        .map_err(|e| CommandError::Window(e.to_string()))
}
