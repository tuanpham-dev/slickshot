use std::sync::Mutex;

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::commands::{CommandError, CommandResult};
use crate::geometry::PhysRect;
use crate::images::ImageStore;

const LABEL: &str = "thumbnail";
/// Logical size of the floating preview. Wide enough to read a captured
/// dialog at a glance, small enough to stay out of the way.
const WIDTH: u32 = 320;
const HEIGHT: u32 = 260;
/// Gap from the monitor's bottom-right corner.
const MARGIN: i32 = 24;

/// What the visible thumbnail is showing. Held so the image can be released
/// when the window closes by any route (its own button, the auto-dismiss
/// timer, or a new capture replacing it).
pub struct ThumbnailState {
    pub image_id: String,
    /// Whether a timeout should keep this capture. Resolved once, when the
    /// thumbnail opens, because a CLI `--auto-save` override applies to the
    /// capture that asked for it and must survive until this window closes
    /// -- long after `deliver_capture` has returned.
    pub auto_save: bool,
}

#[derive(Default)]
pub struct ThumbnailImage(pub Mutex<Option<ThumbnailState>>);

/// Actions the thumbnail's button row can take on the capture it's showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThumbnailAction {
    Copy,
    Quicksave,
    Pin,
    Edit,
    Upload,
}

/// Opens (or replaces) the floating post-capture thumbnail for `image_id`,
/// anchored to the bottom-right of the monitor the capture came from.
///
/// Unlike pins, only one thumbnail exists at a time -- a second capture
/// supersedes the first rather than stacking, so the window is reused when
/// it's already open. The build path mirrors `pin::pin_image`'s spawn +
/// `run_on_main_thread` dance for the same reason documented there (building
/// a webview inline from inside the event loop's own dispatch deadlocks on
/// Windows).
pub async fn show(
    app: &AppHandle,
    image_id: &str,
    rect: PhysRect,
    auto_save: bool,
) -> CommandResult<()> {
    // Releasing the previous capture here (rather than when its window
    // closed) keeps back-to-back captures from leaking the earlier image.
    let previous = app.state::<ThumbnailImage>().0.lock().unwrap().replace(ThumbnailState {
        image_id: image_id.to_string(),
        auto_save,
    });
    if let Some(old) = previous {
        if old.image_id != image_id {
            app.state::<ImageStore>().remove(&old.image_id);
        }
    }

    let position = corner_position(app, rect);

    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_position(Position::Physical(position));
        // The window is already loaded, so hand it the new capture over an
        // event rather than a fresh navigation.
        let _ = tauri::Emitter::emit_to(app, LABEL, "thumbnail:image", image_id.to_string());
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let url = format!("index.html#thumbnail?image={image_id}");
    let app_spawn = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_for_build = app_spawn.clone();
        let result = app_spawn.run_on_main_thread(move || {
            if let Err(e) = build_window(&app_for_build, &url, position) {
                eprintln!("[thumbnail] failed to open window: {e}");
            }
        });
        if let Err(e) = result {
            eprintln!("[thumbnail] failed to schedule window build: {e}");
        }
    });

    Ok(())
}

/// Bottom-right of whichever monitor contains the capture's center, falling
/// back to the capture rect itself when no monitor matches (an unplugged
/// display between capture and delivery).
fn corner_position(app: &AppHandle, rect: PhysRect) -> PhysicalPosition<i32> {
    let center = PhysicalPosition::new(
        (rect.x + rect.w as i32 / 2) as f64,
        (rect.y + rect.h as i32 / 2) as f64,
    );
    let monitor = app
        .monitor_from_point(center.x, center.y)
        .ok()
        .flatten();

    let (mx, my, mw, mh) = match monitor {
        Some(m) => {
            let p = m.position();
            let s = m.size();
            (p.x, p.y, s.width as i32, s.height as i32)
        }
        None => (rect.x, rect.y, rect.w as i32, rect.h as i32),
    };

    PhysicalPosition::new(
        mx + mw - WIDTH as i32 - MARGIN,
        my + mh - HEIGHT as i32 - MARGIN,
    )
}

fn build_window(app: &AppHandle, url: &str, position: PhysicalPosition<i32>) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("SlickShot — Capture")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Physical, not logical -- see overlay.rs::position_fullscreen.
    window
        .set_size(Size::Physical(PhysicalSize::new(WIDTH, HEIGHT)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(Position::Physical(position))
        .map_err(|e| e.to_string())?;

    let cleanup_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            release_current(&cleanup_app);
        }
    });

    Ok(())
}

/// Drops the image the thumbnail was holding. Safe to call twice.
fn release_current(app: &AppHandle) {
    let current = app.state::<ThumbnailImage>().0.lock().unwrap().take();
    if let Some(current) = current {
        app.state::<ImageStore>().remove(&current.image_id);
    }
}

/// Called by the thumbnail webview once it has drawn the capture, so the
/// window never flashes blank (same handshake as `pin_ready`).
#[tauri::command]
pub fn thumbnail_ready(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
    }
}

/// Hides the thumbnail and frees its image.
///
/// `discard` separates the two ways a thumbnail goes away. Letting it time
/// out means the user never said what to do with the capture, so auto-save
/// keeps it; pressing Discard (or Esc) is an explicit "throw this away" and
/// never writes a file. Actions that already did something with the image
/// (copy, save, pin, edit, upload) pass `discard: true` so auto-save does
/// not write a second, redundant copy.
///
/// Hidden rather than closed so the next capture reuses the loaded webview
/// instead of paying for a fresh page load, matching the editor/overlay
/// prewarm approach.
#[tauri::command]
pub fn thumbnail_close(app: AppHandle, discard: bool) -> CommandResult<()> {
    if !discard {
        let pending = {
            let state = app.state::<ThumbnailImage>();
            let held = state.0.lock().unwrap();
            held.as_ref()
                .filter(|s| s.auto_save)
                .and_then(|s| app.state::<ImageStore>().get(&s.image_id))
        };
        if let Some(image) = pending {
            crate::export::autosave_image(&app, &image)?;
        }
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    release_current(&app);
    Ok(())
}

#[tauri::command]
pub async fn thumbnail_action(app: AppHandle, action: ThumbnailAction) -> CommandResult<()> {
    let image_id = app
        .state::<ThumbnailImage>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.image_id.clone())
        .ok_or_else(|| CommandError::Image("the thumbnail is not showing a capture".into()))?;
    let image = app
        .state::<ImageStore>()
        .get(&image_id)
        .ok_or_else(|| CommandError::Image(format!("unknown image id {image_id}")))?;

    match action {
        ThumbnailAction::Copy => {
            crate::export::copy_image_to_clipboard(image.as_ref().clone())?;
            thumbnail_close(app, true)?;
        }
        ThumbnailAction::Quicksave => {
            let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
            let path = crate::export::quicksave_file(&settings);
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| CommandError::Image(e.to_string()))?;
            }
            std::fs::write(&path, crate::images::encode_png(&image))
                .map_err(|e| CommandError::Image(e.to_string()))?;
            crate::export::notify_saved(&app, &path.to_string_lossy());
            thumbnail_close(app, true)?;
        }
        ThumbnailAction::Pin => {
            // The pin takes over ownership of the image, so clear the
            // thumbnail's claim on it first -- releasing after would pull the
            // pixels out from under the pin window.
            let _ = app.state::<ThumbnailImage>().0.lock().unwrap().take();
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.hide();
            }
            let size = PhysRect::new(0, 0, image.width(), image.height());
            crate::pin::pin_image(&app, image_id, centered_rect(&app, size))?;
        }
        ThumbnailAction::Edit => {
            let _ = app.state::<ThumbnailImage>().0.lock().unwrap().take();
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = window.hide();
            }
            crate::editor::show(&app, &image_id).await?;
        }
        ThumbnailAction::Upload => {
            let png = crate::images::encode_png(&image);
            let result = crate::upload::upload_and_record(&app, png)?;
            // The URL is the only useful artifact of an upload, and the
            // thumbnail is about to close, so put it where it can be pasted.
            crate::export::copy_text_to_clipboard(result.url)?;
            thumbnail_close(app, true)?;
        }
    }
    Ok(())
}

/// Centers `size` on the primary monitor, for pinning a capture whose
/// original position the thumbnail no longer tracks.
fn centered_rect(app: &AppHandle, size: PhysRect) -> PhysRect {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return size;
    };
    let p = monitor.position();
    let s = monitor.size();
    PhysRect::new(
        p.x + (s.width as i32 - size.w as i32) / 2,
        p.y + (s.height as i32 - size.h as i32) / 2,
        size.w,
        size.h,
    )
}
