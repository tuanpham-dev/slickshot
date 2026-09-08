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
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use tauri::http::{Request, Response, StatusCode};
use tauri::{
    AppHandle, Builder, Emitter, Manager, Runtime, UriSchemeContext, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::commands::{CommandError, CommandResult};
use crate::geometry::PhysRect;
use crate::record::transform::{self, Censor};
use crate::record::{TimeRange, TranscodeOptions, VideoInfo};

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

/// The inclusive byte span a `Range` header asks for, clamped to the file and
/// to `MAX_CHUNK`. `None` means the header was unsatisfiable.
///
/// Separated out because this is the part that is easy to get subtly wrong --
/// `Content-Range` is inclusive at both ends, so an off-by-one here makes a
/// `<video>` stall at a seek rather than fail outright.
fn resolve_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let ranges = HttpRange::parse(header, len).ok()?;
    let first = ranges.first()?;
    let start = first.start;
    if start >= len {
        return None;
    }
    let end = (start + first.length.min(MAX_CHUNK)).min(len).saturating_sub(1);
    Some((start, end))
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

    let Some((start, end)) = resolve_range(range, len) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{len}"))
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap();
    };
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

// -- Export -----------------------------------------------------------------
//
// Shaped like the image editor's `export_prepare`/`export_commit` pair, and
// for the same reason: the annotation overlay is a PNG that has to cross IPC
// as raw bytes, and a Tauri command takes either a JSON body or a raw one,
// never both. So the description of the export goes over first as JSON, and
// the second call carries only the overlay's bytes (empty when there is none).

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VideoFormat {
    Mp4,
    Gif,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VideoDest {
    /// An explicit path the user picked in a save dialog.
    Path { path: String },
    /// The configured save folder, named like a screenshot quicksave.
    Quicksave,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoExportRequest {
    pub id: String,
    pub range: TimeRange,
    /// Playback multiplier: 2.0 makes the output half as long.
    pub speed: f32,
    /// Region of the source frame to keep, before resizing.
    #[serde(default)]
    pub crop: Option<PhysRect>,
    pub output_size: (u32, u32),
    pub format: VideoFormat,
    pub dest: VideoDest,
    #[serde(default)]
    pub censors: Vec<Censor>,
    #[serde(default)]
    pub keep_audio: bool,
    /// Frames per second for a GIF; ignored for MP4, which keeps the source's
    /// own frame timing.
    #[serde(default)]
    pub gif_fps: Option<u32>,
}

#[derive(Default)]
pub struct PendingVideoExport(pub Mutex<Option<VideoExportRequest>>);

#[derive(Debug, Clone, Serialize)]
pub struct VideoExportResult {
    pub saved_path: String,
}

#[derive(Clone, Serialize)]
struct ExportProgress {
    done: u64,
    total: u64,
}

#[tauri::command]
pub fn video_export_prepare(
    state: tauri::State<PendingVideoExport>,
    request: VideoExportRequest,
) -> CommandResult<()> {
    *state.0.lock().unwrap() = Some(request);
    Ok(())
}

/// Runs the prepared export. The raw body is the annotation overlay as a PNG,
/// already sized to the *output*; an empty body means there is nothing to
/// burn in.
#[tauri::command]
pub async fn video_export(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<VideoExportResult> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "video_export expects a raw binary body, not JSON".into(),
            ))
        }
    };

    let req = app
        .state::<PendingVideoExport>()
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| CommandError::Image("no export was prepared".into()))?;

    let src = app
        .state::<VideoStore>()
        .get(&req.id)
        .ok_or_else(|| CommandError::Image("that recording is no longer open".into()))?;

    let overlay = if bytes.is_empty() {
        None
    } else {
        Some(
            image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                .map_err(|e| CommandError::Image(e.to_string()))?
                .to_rgba8(),
        )
    };

    let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
    let dest = match &req.dest {
        VideoDest::Path { path } => PathBuf::from(path),
        VideoDest::Quicksave => crate::export::recording_quicksave_file(&settings)
            .with_extension(match req.format {
                VideoFormat::Mp4 => "mp4",
                VideoFormat::Gif => "gif",
            }),
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CommandError::Image(e.to_string()))?;
    }

    // Encoding is CPU-bound and long enough to matter, so it runs off the
    // async runtime rather than stalling every other command behind it.
    let worker_app = app.clone();
    let worker_dest = dest.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        run_export(&worker_app, &src, &worker_dest, &req, overlay.as_ref())
    })
    .await
    .map_err(|e| CommandError::Image(e.to_string()))??;

    crate::export::notify_saved(&app, &saved.to_string_lossy());
    crate::history::record_saved_video(&app, &saved);
    Ok(VideoExportResult {
        saved_path: saved.to_string_lossy().into_owned(),
    })
}

/// The crop-relative form of everything the export applies per frame.
///
/// The editor works in the *source* clip's coordinates -- a censor at (100,
/// 100) means 100px into the recording, and the overlay PNG is drawn at the
/// recording's own size. Shifting the censors and cropping the overlay to
/// match is done once here rather than per frame.
struct Prepared {
    censors: Vec<Censor>,
    overlay: Option<RgbaImage>,
    output: (u32, u32),
}

impl Prepared {
    fn new(req: &VideoExportRequest, overlay: Option<&RgbaImage>) -> Self {
        let (dx, dy) = req.crop.map(|c| (c.x, c.y)).unwrap_or((0, 0));
        let censors = req
            .censors
            .iter()
            .map(|c| Censor {
                rect: PhysRect::new(c.rect.x - dx, c.rect.y - dy, c.rect.w, c.rect.h),
                mode: c.mode,
            })
            .collect();
        let overlay = overlay.map(|o| match req.crop {
            Some(crop) => transform::crop(o, crop),
            None => o.clone(),
        });
        Self {
            censors,
            overlay,
            output: req.output_size,
        }
    }
}

/// The actual pixel work, shared by both output formats.
///
/// Order matters and is not the obvious one. Everything happens at the
/// source's resolution and the resize comes *last*, so the coordinates the
/// editor sent need no scaling to be meaningful. The annotation overlay goes
/// on after the censors: an arrow blacked out by a censor drawn beneath it is
/// never what someone meant, whereas a censor still covers every pixel of
/// video the overlay leaves clear.
fn process_frame(frame: &mut RgbaImage, prepared: &Prepared, crop: Option<PhysRect>) {
    if let Some(crop) = crop {
        *frame = transform::crop(frame, crop);
    }
    if !prepared.censors.is_empty() {
        transform::apply_censors(frame, &prepared.censors);
    }
    if let Some(overlay) = &prepared.overlay {
        transform::composite_overlay(frame, overlay);
    }
    let (w, h) = prepared.output;
    if frame.dimensions() != (w, h) {
        *frame = transform::resize(frame, w, h);
    }
}

fn run_export(
    app: &AppHandle,
    src: &Path,
    dest: &Path,
    req: &VideoExportRequest,
    overlay: Option<&RgbaImage>,
) -> CommandResult<PathBuf> {
    let backend = crate::record::default_backend();
    let total_ms = req.range.duration_ms().max(1);
    let prepared = Prepared::new(req, overlay);

    match req.format {
        VideoFormat::Mp4 => {
            let opts = TranscodeOptions {
                range: req.range,
                speed: req.speed,
                crop: req.crop,
                output: req.output_size,
                keep_audio: req.keep_audio,
            };
            // The shim's audio path already time-stretches by `speed`; the
            // video side is this callback rewriting each frame's timestamp,
            // so the two land on the same duration.
            let speed = req.speed.max(0.01) as f64;
            let mut last_report = 0u64;
            backend
                .transcode(src, dest, &opts, &mut |mut frame| {
                    process_frame(&mut frame.image, &prepared, req.crop);
                    let elapsed = frame.pts_ms;
                    frame.pts_ms = (frame.pts_ms as f64 / speed) as u64;
                    // Throttled: a 30fps export would otherwise emit an event
                    // per frame and drown the webview in IPC.
                    if elapsed.saturating_sub(last_report) >= 250 {
                        last_report = elapsed;
                        let _ = app.emit(
                            "video:export-progress",
                            ExportProgress {
                                done: elapsed.min(total_ms),
                                total: total_ms,
                            },
                        );
                    }
                    Some(frame)
                })
                .map_err(|e| CommandError::Image(e.to_string()))?;
        }
        VideoFormat::Gif => {
            let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
            let fps = req.gif_fps.unwrap_or(settings.gif_fps).clamp(1, 50);
            // A GIF at a screen recording's native width is enormous and no
            // one views it at 1:1 anyway, so it is capped -- keeping the
            // aspect ratio, and never upscaling a clip that is already small.
            let max_w = settings.gif_max_width.max(64);
            let (out_w, out_h) = prepared.output;
            let gif_size = if out_w > max_w {
                let scaled_h = ((out_h as f64) * (max_w as f64) / (out_w as f64)).round() as u32;
                (max_w, scaled_h.max(1))
            } else {
                (out_w, out_h)
            };
            // Decoding at the *output* rate already applies the speed change:
            // asking for `fps * speed` source frames per second and then
            // playing them back at `fps` is what makes the clip faster.
            let src_fps = ((fps as f32 * req.speed).round() as u32).clamp(1, 120);

            let mut frames: Vec<RgbaImage> = Vec::new();
            let mut last_report = 0u64;
            backend
                .decode_frames(src, req.range, src_fps, &mut |mut frame| {
                    process_frame(&mut frame.image, &prepared, req.crop);
                    if frame.image.dimensions() != gif_size {
                        frame.image = transform::resize(&frame.image, gif_size.0, gif_size.1);
                    }
                    frames.push(frame.image);
                    let elapsed = frame.pts_ms.saturating_sub(req.range.start_ms);
                    if elapsed.saturating_sub(last_report) >= 250 {
                        last_report = elapsed;
                        let _ = app.emit(
                            "video:export-progress",
                            ExportProgress {
                                done: elapsed.min(total_ms),
                                total: total_ms,
                            },
                        );
                    }
                    true
                })
                .map_err(|e| CommandError::Image(e.to_string()))?;

            let file = std::fs::File::create(dest).map_err(|e| CommandError::Image(e.to_string()))?;
            crate::record::gif::encode(frames, fps, std::io::BufWriter::new(file))
                .map_err(|e| CommandError::Image(e.to_string()))?;
        }
    }

    let _ = app.emit(
        "video:export-progress",
        ExportProgress {
            done: total_ms,
            total: total_ms,
        },
    );
    Ok(dest.to_path_buf())
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

/// Whether recording can work on this machine.
///
/// macOS and Windows use frameworks that are part of the OS, so the answer is
/// always yes there. Linux needs GStreamer and an H.264 encoder installed,
/// which it may not have -- and a Record button that fails only once you have
/// selected a region is worse than one that says so up front.
#[derive(Debug, Clone, Serialize)]
pub struct RecordEngineStatus {
    pub available: bool,
    pub reason: String,
}

#[tauri::command]
pub fn record_engine_status() -> RecordEngineStatus {
    let status = crate::record::linux::engine_status();
    RecordEngineStatus {
        available: status.available,
        reason: status.reason,
    }
}

/// Whether the configured host accepts video at all. Imgur and imgbb are
/// image-only, so the editor hides Upload rather than offering a button that
/// can only fail.
#[tauri::command]
pub fn video_upload_supported(app: AppHandle) -> bool {
    use crate::settings::UploadProvider;
    let settings = crate::settings::get_settings(app).unwrap_or_default();
    matches!(
        settings.upload_provider,
        UploadProvider::Catbox | UploadProvider::S3 | UploadProvider::Gdrive
    )
}

/// Exports the prepared trim to a temporary MP4 and uploads that.
///
/// Separate from `video_export` because the file never belongs anywhere on
/// disk: it is built, sent, and deleted.
#[tauri::command]
pub async fn video_upload(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<crate::upload::UploadResult> {
    // Carries the annotation overlay like `video_export` does -- without it,
    // uploading silently dropped every annotation the user had drawn.
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "video_upload expects a raw binary body, not JSON".into(),
            ))
        }
    };
    let overlay = if bytes.is_empty() {
        None
    } else {
        Some(
            image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                .map_err(|e| CommandError::Image(e.to_string()))?
                .to_rgba8(),
        )
    };

    let req = app
        .state::<PendingVideoExport>()
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| CommandError::Image("no export was prepared".into()))?;

    let src = app
        .state::<VideoStore>()
        .get(&req.id)
        .ok_or_else(|| CommandError::Image("that recording is no longer open".into()))?;

    let temp = std::env::temp_dir().join(format!("slickshot-upload-{}.mp4", uuid::Uuid::new_v4()));
    let worker_app = app.clone();
    let worker_temp = temp.clone();
    let built = tauri::async_runtime::spawn_blocking(move || {
        run_export(&worker_app, &src, &worker_temp, &req, overlay.as_ref())
    })
    .await
    .map_err(|e| CommandError::Image(e.to_string()))?;
    if let Err(e) = built {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }

    let bytes = std::fs::read(&temp).map_err(|e| CommandError::Image(e.to_string()))?;
    let uploaded_at = crate::upload::filename_timestamp_rfc3339();
    let result = crate::upload::upload_and_record(
        &app,
        crate::upload::UploadMedia::mp4(bytes, &uploaded_at),
    );
    // Whether it uploaded or not, the temp copy has no reason to survive.
    let _ = std::fs::remove_file(&temp);
    result
}

/// Whether the prepared export would change anything, or is just the whole
/// clip as it already is on disk.
fn is_untouched(req: &VideoExportRequest, info: &VideoInfo) -> bool {
    req.range.start_ms == 0
        && req.range.end_ms >= info.duration_ms
        && (req.speed - 1.0).abs() < 1e-3
        && req.crop.is_none()
        && req.censors.is_empty()
        && req.output_size == (info.width, info.height)
        && req.format == VideoFormat::Mp4
}

/// Puts the recording on the clipboard as a file, so pasting into Finder
/// copies the MP4 and pasting into a mail or chat window attaches it.
///
/// Uses the *prepared* export, not the raw file: someone who has just trimmed
/// a clip and pressed Copy file means the trim, the same as Save As does. An
/// untrimmed, unmodified clip short-circuits to the file already on disk
/// rather than re-encoding it for nothing.
#[tauri::command]
pub async fn video_copy_file(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<()> {
    // Carries the overlay for the same reason `video_export` does: a copied
    // clip has to look like the one that would be saved.
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => Vec::new(),
    };
    let overlay = if bytes.is_empty() {
        None
    } else {
        Some(
            image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                .map_err(|e| CommandError::Image(e.to_string()))?
                .to_rgba8(),
        )
    };

    let req = app
        .state::<PendingVideoExport>()
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| CommandError::Image("no export was prepared".into()))?;

    let src = app
        .state::<VideoStore>()
        .get(&req.id)
        .ok_or_else(|| CommandError::Image("that recording is no longer open".into()))?;

    let info = crate::record::default_backend()
        .probe(&src)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    if is_untouched(&req, &info) && overlay.is_none() {
        return crate::record::clipboard::copy_file(&src).map_err(CommandError::Image);
    }

    // Named, not a UUID: pasting in Finder creates a file with this name, and
    // it lives beside the other in-progress recordings so the 24h sweep
    // eventually clears it.
    let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
    let name = crate::export::recording_quicksave_file(&settings)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Recording.mp4".into());
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Image(e.to_string()))?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Image(e.to_string()))?;
    let dest = dir.join(name);

    let worker_app = app.clone();
    let worker_dest = dest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_export(&worker_app, &src, &worker_dest, &req, overlay.as_ref())
    })
    .await
    .map_err(|e| CommandError::Image(e.to_string()))??;

    crate::record::clipboard::copy_file(&dest).map_err(CommandError::Image)
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

    #[test]
    fn a_leading_range_is_inclusive_at_both_ends() {
        // `curl -r 0-99` must answer `Content-Range: bytes 0-99/<len>`: 100
        // bytes, not 99 and not 101.
        let (start, end) = resolve_range("bytes=0-99", 5_000).expect("satisfiable");
        assert_eq!((start, end), (0, 99));
        assert_eq!(end - start + 1, 100, "exactly the hundred bytes asked for");
    }

    #[test]
    fn an_open_ended_range_is_capped_to_one_chunk() {
        // What a <video> actually sends: "the rest of the file". Answering it
        // in full would pull a whole recording into memory per seek.
        let len = MAX_CHUNK * 3;
        let (start, end) = resolve_range("bytes=0-", len).expect("satisfiable");
        assert_eq!(start, 0);
        assert_eq!(end, MAX_CHUNK - 1, "capped at the chunk ceiling");
    }

    #[test]
    fn a_range_near_the_end_stops_at_the_last_byte() {
        let (start, end) = resolve_range("bytes=990-", 1_000).expect("satisfiable");
        assert_eq!((start, end), (990, 999), "never past the final byte");
    }

    #[test]
    fn a_suffix_range_counts_back_from_the_end() {
        let (start, end) = resolve_range("bytes=-100", 1_000).expect("satisfiable");
        assert_eq!((start, end), (900, 999));
    }

    #[test]
    fn an_unsatisfiable_range_is_rejected() {
        assert!(resolve_range("bytes=5000-6000", 1_000).is_none(), "past the end");
        assert!(resolve_range("nonsense", 1_000).is_none());
        assert!(resolve_range("bytes=0-10", 0).is_none(), "an empty file");
    }

    fn request(output: (u32, u32)) -> VideoExportRequest {
        VideoExportRequest {
            id: "x".into(),
            range: TimeRange {
                start_ms: 0,
                end_ms: 1_000,
            },
            speed: 1.0,
            crop: None,
            output_size: output,
            format: VideoFormat::Mp4,
            dest: VideoDest::Quicksave,
            censors: Vec::new(),
            keep_audio: false,
            gif_fps: None,
        }
    }

    #[test]
    fn a_frame_is_cropped_then_resized_to_the_output() {
        let mut frame = RgbaImage::from_pixel(100, 80, image::Rgba([10, 20, 30, 255]));
        let mut req = request((20, 20));
        req.crop = Some(PhysRect::new(10, 10, 40, 40));
        process_frame(&mut frame, &Prepared::new(&req, None), req.crop);
        assert_eq!(frame.dimensions(), (20, 20), "the output size wins");
    }

    #[test]
    fn a_frame_with_no_crop_is_still_resized() {
        let mut frame = RgbaImage::from_pixel(64, 64, image::Rgba([1, 2, 3, 255]));
        let req = request((32, 16));
        process_frame(&mut frame, &Prepared::new(&req, None), None);
        assert_eq!(frame.dimensions(), (32, 16));
    }

    #[test]
    fn the_overlay_goes_on_last_so_censors_cannot_cover_it() {
        // A censor over the whole frame, and an opaque overlay pixel on top:
        // if the order were reversed the overlay would be blacked out.
        let mut frame = RgbaImage::from_pixel(8, 8, image::Rgba([200, 200, 200, 255]));
        let mut req = request((8, 8));
        req.censors = vec![Censor {
            rect: PhysRect::new(0, 0, 8, 8),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let mut overlay = RgbaImage::from_pixel(8, 8, image::Rgba([0, 0, 0, 0]));
        overlay.put_pixel(2, 2, image::Rgba([255, 0, 0, 255]));

        process_frame(&mut frame, &Prepared::new(&req, Some(&overlay)), None);
        assert_eq!(
            frame.get_pixel(2, 2).0,
            [255, 0, 0, 255],
            "the annotation survives the censor beneath it"
        );
        assert_eq!(
            frame.get_pixel(5, 5).0,
            [0, 0, 0, 255],
            "and the censor still covers everywhere the overlay is clear"
        );
    }

    #[test]
    fn a_censor_lands_where_the_editor_drew_it_after_a_crop() {
        // The editor works in source coordinates: a censor at (60,60) means
        // 60px into the *recording*. With the crop starting at (50,50) it has
        // to end up at (10,10) in the cropped frame -- getting this backwards
        // puts every censor in the wrong place the moment someone crops.
        let mut frame = RgbaImage::from_pixel(200, 200, image::Rgba([255, 255, 255, 255]));
        let mut req = request((100, 100));
        req.crop = Some(PhysRect::new(50, 50, 100, 100));
        req.censors = vec![Censor {
            rect: PhysRect::new(60, 60, 20, 20),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let prepared = Prepared::new(&req, None);
        process_frame(&mut frame, &prepared, req.crop);

        assert_eq!(
            frame.get_pixel(15, 15).0,
            [0, 0, 0, 255],
            "the censor should cover (10,10)-(30,30) of the cropped frame"
        );
        assert_eq!(
            frame.get_pixel(45, 45).0,
            [255, 255, 255, 255],
            "and nothing outside it"
        );
    }

    #[test]
    fn the_overlay_is_cropped_the_same_way_the_frame_is() {
        // The overlay PNG is drawn at the source's size, so it has to be cut
        // to the same window or every annotation slides by the crop origin.
        let mut frame = RgbaImage::from_pixel(200, 200, image::Rgba([255, 255, 255, 255]));
        let mut req = request((100, 100));
        req.crop = Some(PhysRect::new(50, 50, 100, 100));

        let mut overlay = RgbaImage::from_pixel(200, 200, image::Rgba([0, 0, 0, 0]));
        overlay.put_pixel(120, 120, image::Rgba([255, 0, 0, 255]));

        let prepared = Prepared::new(&req, Some(&overlay));
        process_frame(&mut frame, &prepared, req.crop);
        assert_eq!(
            frame.get_pixel(70, 70).0,
            [255, 0, 0, 255],
            "a mark at (120,120) of the source belongs at (70,70) after a crop at (50,50)"
        );
    }

    #[test]
    fn the_resize_happens_after_everything_else() {
        // Censor coordinates are the source's, so a half-size output must not
        // make the editor's numbers mean something different.
        let mut frame = RgbaImage::from_pixel(200, 200, image::Rgba([255, 255, 255, 255]));
        let mut req = request((100, 100));
        req.censors = vec![Censor {
            rect: PhysRect::new(0, 0, 100, 100),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let prepared = Prepared::new(&req, None);
        process_frame(&mut frame, &prepared, None);

        assert_eq!(frame.dimensions(), (100, 100));
        // The censored top-left quarter of the source is the top-left quarter
        // of the output too.
        assert_eq!(frame.get_pixel(20, 20).0, [0, 0, 0, 255]);
        assert_eq!(frame.get_pixel(70, 70).0, [255, 255, 255, 255]);
    }

    #[test]
    fn an_export_request_round_trips_through_json() {
        // The frontend builds this by hand, so the tags have to match.
        let json = r#"{
            "id": "abc",
            "range": { "start_ms": 100, "end_ms": 900 },
            "speed": 2.0,
            "output_size": [320, 240],
            "format": "gif",
            "dest": { "kind": "path", "path": "/tmp/a.gif" },
            "censors": [{ "rect": {"x":1,"y":2,"w":3,"h":4}, "kind": "pixelate", "block": 8 }],
            "keep_audio": true
        }"#;
        let req: VideoExportRequest = serde_json::from_str(json).expect("parse");
        assert_eq!(req.format, VideoFormat::Gif);
        assert_eq!(req.range.duration_ms(), 800);
        assert_eq!(req.output_size, (320, 240));
        assert_eq!(req.censors.len(), 1);
        assert!(req.crop.is_none(), "an omitted crop is None, not an error");
        match req.dest {
            VideoDest::Path { ref path } => assert_eq!(path, "/tmp/a.gif"),
            _ => panic!("expected a path destination"),
        }
    }
}
