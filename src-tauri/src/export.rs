use std::sync::Mutex;

use image::ImageFormat;
use serde::{Deserialize, Serialize};
use tauri_plugin_notification::NotificationExt;

use crate::commands::{CommandError, CommandResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportAction {
    Clipboard,
    Save { path: String },
    Quicksave,
}

#[derive(Default)]
pub struct PendingExport(pub Mutex<Option<ExportAction>>);

#[tauri::command]
pub fn export_prepare(state: tauri::State<PendingExport>, action: ExportAction) -> CommandResult<()> {
    *state.0.lock().unwrap() = Some(action);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub saved_path: Option<String>,
}

#[tauri::command]
pub fn export_commit(
    app: tauri::AppHandle,
    state: tauri::State<PendingExport>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<ExportResult> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "export_commit expects a raw binary body, not JSON".into(),
            ))
        }
    };

    let action = state
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| CommandError::Image("no export was prepared".into()))?;

    let img = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_rgba8();

    match action {
        ExportAction::Clipboard => {
            copy_image_to_clipboard(img)?;
            Ok(ExportResult { saved_path: None })
        }
        ExportAction::Save { path } => {
            save_to_path(&bytes, &path)?;
            notify_saved(&app, &path);
            Ok(ExportResult { saved_path: Some(path) })
        }
        ExportAction::Quicksave => {
            let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
            let path = quicksave_file(&settings);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| CommandError::Image(e.to_string()))?;
            }
            std::fs::write(&path, &bytes).map_err(|e| CommandError::Image(e.to_string()))?;
            let saved_path = path.to_string_lossy().into_owned();
            notify_saved(&app, &saved_path);
            Ok(ExportResult {
                saved_path: Some(saved_path),
            })
        }
    }
}

/// Destination for a quicksave: the configured save dir (or a `Screenshots`
/// fallback under the platform's Pictures dir) plus a timestamped filename.
/// Always `.png` -- quicksave has never consulted `default_format`, and this
/// preserves that existing behavior; used by both `export_commit`'s
/// `Quicksave` action and the CLI's default (no-flags) output sink.
pub(crate) fn quicksave_file(settings: &crate::settings::Settings) -> std::path::PathBuf {
    let dir = settings
        .save_dir
        .as_ref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            dirs::picture_dir()
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
                .join("Screenshots")
        });
    let filename = format!("Screenshot {}.png", filename_timestamp());
    dir.join(filename)
}

pub(crate) fn notify_saved(app: &tauri::AppHandle, path: &str) {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let _ = app
        .notification()
        .builder()
        .title("Screenshot saved")
        .body(name)
        .show();
}

#[tauri::command]
pub fn copy_text_to_clipboard(text: String) -> CommandResult<()> {
    copy_text_to_clipboard_impl(text)
}

/// On X11/Wayland the clipboard is served by whichever process last claimed
/// ownership -- there is no independent system clipboard service like on
/// macOS/Windows. If we set the image and return, our process keeps running
/// but arboard's `Clipboard` handle (and its connection) is dropped at the
/// end of the call, which releases ownership immediately and empties the
/// clipboard before anything can paste from it. `SetExtLinux::wait()` keeps
/// a connection alive to keep serving paste requests until something else
/// overwrites the clipboard, so it must run on its own detached thread
/// (it blocks for as long as it's serving).
#[cfg(target_os = "linux")]
pub(crate) fn copy_image_to_clipboard(img: image::RgbaImage) -> CommandResult<()> {
    use arboard::SetExtLinux;

    let width = img.width() as usize;
    let height = img.height() as usize;
    let bytes = img.into_raw();

    std::thread::spawn(move || {
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            let _ = clipboard.set().wait().image(arboard::ImageData {
                width,
                height,
                bytes: bytes.into(),
            });
        }
    });
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn copy_image_to_clipboard(img: image::RgbaImage) -> CommandResult<()> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| CommandError::Image(e.to_string()))?;
    clipboard
        .set_image(arboard::ImageData {
            width: img.width() as usize,
            height: img.height() as usize,
            bytes: img.into_raw().into(),
        })
        .map_err(|e| CommandError::Image(e.to_string()))
}

#[cfg(target_os = "linux")]
fn copy_text_to_clipboard_impl(text: String) -> CommandResult<()> {
    use arboard::SetExtLinux;
    std::thread::spawn(move || {
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            let _ = clipboard.set().wait().text(text);
        }
    });
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn copy_text_to_clipboard_impl(text: String) -> CommandResult<()> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| CommandError::Image(e.to_string()))?;
    clipboard.set_text(text).map_err(|e| CommandError::Image(e.to_string()))
}

fn save_to_path(png_bytes: &[u8], path: &str) -> CommandResult<()> {
    let lower = path.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        let img = image::load_from_memory_with_format(png_bytes, ImageFormat::Png)
            .map_err(|e| CommandError::Image(e.to_string()))?;
        img.to_rgb8()
            .save_with_format(path, ImageFormat::Jpeg)
            .map_err(|e| CommandError::Image(e.to_string()))?;
    } else {
        std::fs::write(path, png_bytes).map_err(|e| CommandError::Image(e.to_string()))?;
    }
    Ok(())
}

fn filename_timestamp() -> String {
    use time::macros::format_description;
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let fmt = format_description!("[year]-[month]-[day] [hour]-[minute]-[second]");
    now.format(&fmt).unwrap_or_else(|_| "untitled".to_string())
}
