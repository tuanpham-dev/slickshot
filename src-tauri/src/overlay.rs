use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::commands::{CaptureMode, Capturer};
use crate::geometry::{PhysPoint, PhysRect};
use crate::images::ImageStore;
use crate::session::CaptureSession;

/// Frame-image ids inserted into `ImageStore` for the currently open overlay
/// set, so `close_overlays` can free them.
#[derive(Default)]
pub struct OverlayImages(pub Mutex<Vec<String>>);

/// Monitor whose overlay window should take keyboard focus once shown --
/// the one under the cursor when the capture started. Set by
/// `open_overlays`, consumed by `overlay_ready`.
#[derive(Default)]
pub struct OverlayFocus(pub Mutex<Option<u32>>);

fn overlay_label(monitor_id: u32) -> String {
    format!("overlay-{monitor_id}")
}

#[derive(Clone, Serialize)]
struct OverlayFrame {
    image_id: String,
    /// Region/Window/Translate -- drives interaction mode in the overlay
    /// webview (drag-to-select vs. click-a-window vs. drag-then-translate).
    mode: CaptureMode,
}

/// Creates one hidden, already-loaded overlay window per monitor at startup.
/// Region/window capture then reuses these (repositioning and re-emitting a
/// fresh frame) instead of building a brand new `WebviewWindow` -- and in
/// particular reloading the whole JS bundle from scratch -- on every single
/// capture, which was the dominant cost behind the multi-second blank
/// window users saw before the overlay's frozen frame appeared.
pub fn prewarm(app: &AppHandle) -> Result<(), String> {
    let capturer = app.state::<Capturer>();
    let monitors = capturer.0.monitors().map_err(|e| e.to_string())?;
    for monitor in monitors {
        ensure_window(app, monitor.id, monitor.rect)?;
    }
    Ok(())
}

fn ensure_window(app: &AppHandle, monitor_id: u32, rect: PhysRect) -> Result<WebviewWindow, String> {
    let label = overlay_label(monitor_id);
    if let Some(window) = app.get_webview_window(&label) {
        position_fullscreen(&window, rect)?;
        return Ok(window);
    }

    let url = format!("index.html#overlay?monitor={monitor_id}");
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("SlickShot")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    position_fullscreen(&window, rect)?;
    Ok(window)
}

fn position_fullscreen(window: &WebviewWindow, rect: PhysRect) -> Result<(), String> {
    // WebviewWindowBuilder::position/inner_size (and set_size/set_position)
    // take *logical* pixels and scale by the window's DPI factor -- wrong
    // for our physical-pixel monitor rects on a system with GDK_SCALE != 1.
    window
        .set_size(Size::Physical(PhysicalSize::new(rect.w, rect.h)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(rect.x, rect.y)))
        .map_err(|e| e.to_string())?;

    // XFWM (and likely other X11 WMs) shift an explicitly-positioned
    // undecorated window down to avoid a panel strut, even though it
    // should cover the whole monitor. Fullscreening after positioning
    // makes the WM give it the monitor's full geometry, panel included.
    //
    // NOT on macOS: there `set_fullscreen(true)` triggers *native*
    // fullscreen, which macOS moves into its own isolated Space. With one
    // overlay window per monitor, each overlay lands on a separate desktop
    // instead of being a borderless always-on-top window covering its
    // monitor -- so the multi-monitor overlay collapses to a single
    // full-screen Space. The explicit physical set_size/set_position above
    // already covers the monitor correctly on macOS (and Windows), so the
    // fullscreen call is only needed as the X11 WM workaround.
    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn open_overlays(app: &AppHandle, mode: CaptureMode) -> Result<(), String> {
    let session_state = app.state::<Mutex<Option<CaptureSession>>>();
    let images = app.state::<ImageStore>();
    let overlay_images = app.state::<OverlayImages>();

    // Scoped so the `MutexGuard` (never `Send`) is unambiguously dropped
    // before the `.await` below -- required for this function's future to
    // itself be `Send`, which `tauri::async_runtime::spawn` demands.
    let (cursor, inserted_ids, labels) = {
        let session_guard = session_state.lock().unwrap();
        let session = session_guard.as_ref().ok_or("no active capture session")?;

        let cursor = find_cursor_monitor(app, session);

        let mut inserted_ids = Vec::new();
        let mut labels = Vec::new();

        for frame in &session.frames {
            let image_id = images.insert_arc(frame.image.clone());
            inserted_ids.push(image_id.clone());

            ensure_window(app, frame.monitor.id, frame.monitor.rect)?;
            labels.push((overlay_label(frame.monitor.id), image_id));
        }
        (cursor, inserted_ids, labels)
    };

    // A prewarmed overlay window's page loads asynchronously; emitting the
    // frame before its `listen("overlay:frame", ...)` call has registered
    // means the event is simply dropped and the window (shown only once
    // `overlay_ready` fires back) stays hidden forever. See
    // `ready::wait_for_mount` -- this matters most on a true cold start,
    // where this can otherwise run before the event loop has pumped even
    // once.
    for (label, _) in &labels {
        crate::ready::wait_for_mount(app, label, std::time::Duration::from_secs(3)).await;
    }
    for (label, image_id) in labels {
        app.emit_to(&label, "overlay:frame", OverlayFrame { image_id, mode })
            .map_err(|e| e.to_string())?;
    }

    *overlay_images.0.lock().unwrap() = inserted_ids;
    *app.state::<OverlayFocus>().0.lock().unwrap() = Some(cursor);

    // The windows are NOT shown here: each one is shown by `overlay_ready`
    // once its webview has actually drawn the frozen frame. Showing earlier
    // flashed a blank window for the fetch+draw duration.
    Ok(())
}

/// Called by each overlay webview after it has drawn its frozen frame --
/// only then is the window shown, so the user never sees a blank overlay.
#[tauri::command]
pub fn overlay_ready(app: AppHandle, monitor_id: u32) {
    // A cancel/confirm may race a slow frame draw; `close_overlays` drains
    // the image list, so an empty list means this ready is stale and the
    // window must stay hidden.
    if app.state::<OverlayImages>().0.lock().unwrap().is_empty() {
        return;
    }
    let Some(window) = app.get_webview_window(&overlay_label(monitor_id)) else {
        return;
    };
    let _ = window.show();
    let should_focus = app
        .state::<OverlayFocus>()
        .0
        .lock()
        .unwrap()
        .is_some_and(|id| id == monitor_id);
    if should_focus {
        let _ = window.set_focus();
    }
}

fn find_cursor_monitor(app: &AppHandle, session: &CaptureSession) -> u32 {
    let fallback = session
        .frames
        .first()
        .map(|f| f.monitor.id)
        .unwrap_or_default();

    let Some(any_window) = app.webview_windows().values().next().cloned() else {
        return fallback;
    };
    let Ok(pos) = any_window.cursor_position() else {
        return fallback;
    };
    let point = PhysPoint::new(pos.x as i32, pos.y as i32);
    session
        .frames
        .iter()
        .find(|f| f.monitor.rect.contains(point))
        .map(|f| f.monitor.id)
        .unwrap_or(fallback)
}

/// Hides the overlay windows and frees their frame images -- the windows
/// themselves stay alive (pre-warmed) for the next capture. See `prewarm`.
pub fn close_overlays(app: &AppHandle) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("overlay-"))
        .cloned()
        .collect();
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.hide();
        }
    }

    let images = app.state::<ImageStore>();
    let overlay_images = app.state::<OverlayImages>();
    for id in overlay_images.0.lock().unwrap().drain(..) {
        images.remove(&id);
    }
}
