//! Serving recordings to the webview, and the Video Editor window.
//!
//! A `<video>` element needs byte-range requests to seek, which the
//! `slickshot://` frame protocol has no reason to support -- it hands over
//! whole decoded frames. So recordings get their own protocol, and their own
//! store mapping opaque ids to the files the app itself put there. Tauri's
//! asset protocol would have been the obvious alternative, but its allowed
//! scope has to be declared statically and the save folder is a user setting.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use http_range::HttpRange;
use tauri::http::{Request, Response, StatusCode};
use tauri::{
    AppHandle, Builder, Emitter, Manager, Runtime, UriSchemeContext, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::commands::{CommandError, CommandResult};
use crate::record::VideoInfo;

const LABEL: &str = "video-editor";
/// Chunk ceiling for a ranged response. A `<video>` asking for "the rest of
/// the file" on a long recording would otherwise pull hundreds of megabytes
/// into memory to answer one seek.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

/// Which files the webview is allowed to stream, by opaque id. Only paths the
/// app put here are reachable, so a recording under the user's save folder is
/// served while the rest of their disk is not.
#[derive(Default)]
pub struct VideoStore(Mutex<HashMap<String, PathBuf>>);

impl VideoStore {
    pub fn insert(&self, path: &Path) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.0
            .lock()
            .unwrap()
            .insert(id.clone(), path.to_path_buf());
        id
    }

    pub fn get(&self, id: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<PathBuf> {
        self.0.lock().unwrap().remove(id)
    }
}

/// Serves `slickshot-video://<id>` with range support.
///
/// Answered from a spawned thread for the same reason `register_shot_protocol`
/// is: on Linux the synchronous handler runs on the GTK main thread, and a
/// video seek would block the UI while it read.
pub fn register_video_protocol<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        "slickshot-video",
        |ctx: UriSchemeContext<R>, request: Request<Vec<u8>>, responder| {
            let id = request.uri().path().trim_start_matches('/').to_string();
            let range_header = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let app = ctx.app_handle().clone();

            std::thread::spawn(move || {
                let response = serve(&app, &id, range_header.as_deref());
                responder.respond(response);
            });
        },
    )
}

fn not_found_generic() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

fn serve<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let Some(path) = app.state::<VideoStore>().get(id) else {
        return not_found_generic();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return not_found_generic();
    };
    let len = bytes.len() as u64;

    let Some(range) = range else {
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "video/mp4")
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", len.to_string())
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap();
    };

    let Ok(ranges) = HttpRange::parse(range, len) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{len}"))
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap();
    };
    let Some(first) = ranges.first() else {
        return not_found_generic();
    };

    let start = first.start;
    let end = (start + first.length.min(MAX_CHUNK)).min(len).saturating_sub(1);
    let slice = bytes[start as usize..=(end as usize).min(bytes.len() - 1)].to_vec();

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", "video/mp4")
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{len}"))
        .header("Content-Length", slice.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "content-range")
        .body(slice)
        .unwrap()
}

/// Opens (or reuses) the Video Editor on `path`.
pub async fn open_editor(app: &AppHandle, path: &Path) -> CommandResult<()> {
    let id = app.state::<VideoStore>().insert(path);

    let url = format!("index.html#video-editor?video={id}");
    let window = match app.get_webview_window(LABEL) {
        Some(window) => {
            let _ = window.eval(format!("window.location.hash = '{}'", &url[11..]));
            window
        }
        None => WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
            .title("SlickShot -- Video")
            .inner_size(1200.0, 800.0)
            .center()
            .visible(false)
            .background_color(tauri::window::Color(22, 24, 29, 255))
            .build()
            .map_err(|e| CommandError::Window(e.to_string()))?,
    };

    // Same wait as `editor::show`: a cold-started window's JS cannot have a
    // listener registered yet, and an event emitted before it does is simply
    // dropped -- leaving a window that never shows itself.
    crate::ready::wait_for_mount(app, LABEL, std::time::Duration::from_secs(3)).await;
    let _ = app.emit_to(LABEL, "video-editor:open", id);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Reports a recording's dimensions, duration and whether it has sound.
#[tauri::command]
pub async fn video_probe(app: AppHandle, id: String) -> CommandResult<VideoInfo> {
    let path = app
        .state::<VideoStore>()
        .get(&id)
        .ok_or_else(|| CommandError::Image("that recording is no longer open".into()))?;
    crate::record::default_backend()
        .probe(&path)
        .map_err(|e| CommandError::Image(e.to_string()))
}

/// Drops a recording the user chose not to keep, deleting the temp file. Only
/// files under the app's own recordings directory are removed -- an entry
/// opened from history or the save folder is the user's, not ours.
#[tauri::command]
pub fn video_discard(app: AppHandle, id: String) -> CommandResult<()> {
    let Some(path) = app.state::<VideoStore>().remove(&id) else {
        return Ok(());
    };
    let temp_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("recordings"))
        .unwrap_or_default();
    if path.starts_with(&temp_dir) {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

/// Shows the recording in the system file manager.
#[tauri::command]
pub fn video_reveal(app: AppHandle, id: String) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = app
        .state::<VideoStore>()
        .get(&id)
        .ok_or_else(|| CommandError::Image("that recording is no longer open".into()))?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| CommandError::Image(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_round_trips_and_forgets() {
        let store = VideoStore::default();
        let id = store.insert(Path::new("/tmp/a.mp4"));
        assert_eq!(store.get(&id).as_deref(), Some(Path::new("/tmp/a.mp4")));
        assert_eq!(store.remove(&id).as_deref(), Some(Path::new("/tmp/a.mp4")));
        assert!(store.get(&id).is_none(), "a removed id is unreachable");
    }

    #[test]
    fn unknown_ids_are_not_served() {
        let store = VideoStore::default();
        assert!(store.get("nope").is_none());
    }
}
