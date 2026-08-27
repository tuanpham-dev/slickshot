use std::collections::HashMap;
use std::sync::Mutex;

use image::RgbaImage;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::commands::{CommandError, CommandResult};
use crate::geometry::{PhysPoint, PhysRect};
use crate::images::ImageStore;

#[derive(Default)]
pub struct PinInner {
    counter: u32,
    /// window label -> image id, so `cleanup` can free the right image
    /// regardless of whether the window was closed via `pin_close` (Esc,
    /// double-click, the in-window close button) or an OS-level close (Alt+F4,
    /// a WM's own close action) that never goes through the JS command at all.
    images: HashMap<String, String>,
}

#[derive(Default)]
pub struct PinWindows(pub Mutex<PinInner>);

/// Opens a new, unlimited-count, on-demand pin window (not prewarmed --
/// unlike the editor/overlay windows, the number of simultaneous pins is
/// unbounded, so keeping them warm would leak) showing `image_id` at the
/// given physical rect. The window starts hidden; the pin webview shows it
/// via `pin_ready` once it has drawn the frame, so it never flashes blank.
///
/// The actual `WebviewWindowBuilder::build()` call is deferred through
/// `tauri::async_runtime::spawn` + `run_on_main_thread` rather than called
/// inline, even though this function already runs on the main thread:
/// building a new WebView2-backed window needs the OS message loop pumping
/// to finish the controller's COM-based init, and this function is itself
/// invoked from inside that same loop's dispatch of the IPC message that
/// triggered the pin -- calling `build()` inline deadlocked on Windows
/// (confirmed live: it never returned). `run_on_main_thread` only actually
/// defers to a later loop iteration when called from a thread other than
/// the caller's; called from the main thread itself it just runs the
/// closure inline and hits the identical deadlock. Hence the `spawn`
/// wrapper -- it moves off the main thread first so the subsequent
/// `run_on_main_thread` call is a genuine cross-thread post through the
/// event loop's proxy, not a same-thread passthrough. The editor/overlay
/// windows never hit this because their one and only `build()` call happens
/// during prewarm in `setup()`, before the loop is dispatching anything.
pub fn pin_image(app: &AppHandle, image_id: String, rect: PhysRect) -> CommandResult<()> {
    let label = {
        let state = app.state::<PinWindows>();
        let mut inner = state.0.lock().unwrap();
        inner.counter += 1;
        let label = format!("pin-{}", inner.counter);
        inner.images.insert(label.clone(), image_id.clone());
        label
    };

    let url = format!("index.html#pin?image={image_id}&label={label}");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_for_build = app.clone();
        let result = app.run_on_main_thread(move || {
            if let Err(e) = build_pin_window(&app_for_build, &label, &url, rect) {
                eprintln!("[pin] failed to open pin window: {e}");
            }
        });
        if let Err(e) = result {
            eprintln!("[pin] failed to schedule pin window build: {e}");
        }
    });

    Ok(())
}

fn build_pin_window(app: &AppHandle, label: &str, url: &str, rect: PhysRect) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("SlickShot — Pin")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Physical, not logical -- see overlay.rs::position_fullscreen: the
    // logical-pixel builder/setter APIs are wrong on this machine's scaled
    // X11 setup.
    window
        .set_size(Size::Physical(PhysicalSize::new(rect.w, rect.h)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)))
        .map_err(|e| e.to_string())?;

    let cleanup_label = label.to_string();
    let cleanup_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            cleanup(&cleanup_app, &cleanup_label);
        }
    });

    Ok(())
}

/// Frees the image and forgets the label -- shared by `pin_close` (an
/// explicit in-app dismiss) and the close-requested window event (any other
/// way the window goes away), so the image can never leak either way.
fn cleanup(app: &AppHandle, label: &str) {
    let image_id = app.state::<PinWindows>().0.lock().unwrap().images.remove(label);
    if let Some(id) = image_id {
        app.state::<ImageStore>().remove(&id);
    }
}

/// Called by the pin webview once it has drawn the frame onto its canvas.
#[tauri::command]
pub fn pin_ready(app: AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
    }
}

/// Explicit in-app dismiss (Esc, double-click, the hover close button).
#[tauri::command]
pub fn pin_close(app: AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.close();
    }
    // The window's own close-requested handler also calls `cleanup`, but
    // `close()` is async from the caller's perspective -- clean up
    // immediately too so a rapid pin_close + relaunch can't race a stale
    // image_id still being served over slickshot://.
    cleanup(&app, &label);
}

/// Pins a PNG sent from the editor (the flattened, annotated capture),
/// centered on the cursor's monitor and downscaled to fit within 80% of it
/// if larger.
#[tauri::command]
pub fn pin_editor_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<()> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "pin_editor_image expects a raw binary body, not JSON".into(),
            ))
        }
    };
    let img: RgbaImage = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_rgba8();

    let monitor = cursor_monitor(&app)?;
    let img = fit_to_monitor(img, &monitor.rect);
    let (w, h) = img.dimensions();
    let rect = PhysRect::new(
        monitor.rect.x + (monitor.rect.w as i32 - w as i32) / 2,
        monitor.rect.y + (monitor.rect.h as i32 - h as i32) / 2,
        w,
        h,
    );

    let image_id = app.state::<ImageStore>().insert(img);
    pin_image(&app, image_id, rect)
}

fn cursor_monitor(app: &AppHandle) -> CommandResult<crate::capture::MonitorInfo> {
    let capturer = app.state::<crate::commands::Capturer>();
    let monitors = capturer
        .0
        .monitors()
        .map_err(|e| CommandError::Capture(e.to_string()))?;

    let cursor_point = app
        .webview_windows()
        .values()
        .next()
        .cloned()
        .and_then(|w| w.cursor_position().ok())
        .map(|p| PhysPoint::new(p.x as i32, p.y as i32));

    let monitor = cursor_point
        .and_then(|p| monitors.iter().find(|m| m.rect.contains(p)))
        .or_else(|| monitors.iter().find(|m| m.is_primary))
        .or_else(|| monitors.first())
        .cloned()
        .ok_or_else(|| CommandError::Capture("no monitor available".into()))?;
    Ok(monitor)
}

/// Downscales `img` (preserving aspect ratio) to fit within 80% of
/// `monitor_rect` if it's larger; returns it unchanged otherwise.
fn fit_to_monitor(img: RgbaImage, monitor_rect: &PhysRect) -> RgbaImage {
    let (w, h) = img.dimensions();
    let max_w = (monitor_rect.w as f64 * 0.8).max(1.0);
    let max_h = (monitor_rect.h as f64 * 0.8).max(1.0);
    let scale = (max_w / w as f64).min(max_h / h as f64).min(1.0);

    if scale >= 1.0 {
        return img;
    }
    let target_w = ((w as f64 * scale).round() as u32).max(1);
    let target_h = ((h as f64 * scale).round() as u32).max(1);
    image::imageops::resize(&img, target_w, target_h, image::imageops::FilterType::Lanczos3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_to_monitor_leaves_smaller_image_unchanged() {
        let img = RgbaImage::new(400, 300);
        let monitor_rect = PhysRect::new(0, 0, 1920, 1080);
        let out = fit_to_monitor(img, &monitor_rect);
        assert_eq!(out.dimensions(), (400, 300));
    }

    #[test]
    fn fit_to_monitor_downscales_larger_image_preserving_aspect() {
        let img = RgbaImage::new(3840, 2160);
        let monitor_rect = PhysRect::new(0, 0, 1920, 1080);
        let out = fit_to_monitor(img, &monitor_rect);
        // 80% of 1920x1080 = 1536x864; image is exactly 2x that AR, so it
        // should scale down to fit within both bounds.
        assert!(out.width() <= 1536 && out.height() <= 864);
        let orig_ar = 3840.0 / 2160.0;
        let out_ar = out.width() as f64 / out.height() as f64;
        assert!((orig_ar - out_ar).abs() < 0.01);
    }
}
