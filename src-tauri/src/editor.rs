use std::sync::Mutex;

use tauri::{window::Color, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::commands::{CommandError, CommandResult};
use crate::images::ImageStore;

const LABEL: &str = "editor";

/// Image id currently shown in the editor, so the previous capture's pixels
/// can be freed from `ImageStore` when a new one replaces it (or the editor
/// is dismissed). Without this every capture leaked a full-size image.
#[derive(Default)]
pub struct EditorImage(pub Mutex<Option<String>>);

/// Creates the hidden, already-loaded editor window at startup. Reusing it
/// per capture (emit a fresh image id + show) instead of building a brand
/// new `WebviewWindow` avoids reloading the whole JS bundle every time --
/// the same multi-second dev-build cost `overlay::prewarm` exists to avoid.
pub fn prewarm(app: &AppHandle) -> Result<(), String> {
    ensure_window(app, None).map(|_| ())
}

fn ensure_window(app: &AppHandle, initial_image: Option<&str>) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    // The image id also rides along in the URL so a freshly (re)built window
    // -- whose JS can't have a listener registered yet when `show` emits --
    // still picks it up from the hash params on load.
    let url = match initial_image {
        Some(id) => format!("index.html#editor?image={id}"),
        None => "index.html#editor".to_string(),
    };
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
        .title("SlickShot — Editor")
        .inner_size(1200.0, 800.0)
        .center()
        .visible(false)
        .background_color(Color(22, 24, 29, 255))
        .build()
        .map_err(|e| e.to_string())
}

/// Points the (pre-warmed) editor window at `image_id`. Frees the
/// previously shown image from the store. The window itself is shown by
/// `editor_ready` once the webview has drawn the new image -- showing it
/// here flashed a blank window (or the previous capture) while loading.
pub async fn show(app: &AppHandle, image_id: &str) -> CommandResult<()> {
    let images = app.state::<ImageStore>();
    let current = app.state::<EditorImage>();
    let previous = current.0.lock().unwrap().replace(image_id.to_string());
    if let Some(prev) = previous {
        if prev != image_id {
            images.remove(&prev);
        }
    }

    ensure_window(app, Some(image_id)).map_err(CommandError::Window)?;
    // See `overlay::open_overlays` for why this wait matters: without it, a
    // cold-started `open`/capture can emit `editor:image` before the
    // prewarmed editor page's `listen()` call has registered, and the
    // window (shown only once `editor_ready` fires back) never appears.
    crate::ready::wait_for_mount(app, LABEL, std::time::Duration::from_secs(3)).await;
    app.emit_to(LABEL, "editor:image", image_id.to_string())
        .map_err(|e| CommandError::Window(e.to_string()))?;
    Ok(())
}

/// Called by the editor webview once the capture is rendered on its canvas.
#[tauri::command]
pub fn editor_ready(app: AppHandle, current: State<EditorImage>) {
    // Dismissed (editor_hide) before the draw finished -- stay hidden.
    if current.0.lock().unwrap().is_none() {
        return;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Dismisses the editor: hides the window (keeping it warm for the next
/// capture) and frees the shown image. Called from the editor's close flow
/// -- the JS side always prevents the real close so the window survives.
#[tauri::command]
pub fn editor_hide(app: AppHandle, images: State<ImageStore>, current: State<EditorImage>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    if let Some(id) = current.0.lock().unwrap().take() {
        images.remove(&id);
    }
}
