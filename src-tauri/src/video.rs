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

/// One stretch of the source that plays at a constant rate, and where it
/// lands in the output. Built by the editor (`timelinePlan.ts`) so the
/// piecewise arithmetic has one implementation rather than two; this side
/// only looks moments up in it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PlanSegment {
    pub src_start_ms: f64,
    pub src_end_ms: f64,
    pub out_start_ms: f64,
    pub out_end_ms: f64,
    /// 0 for a freeze: no source span, positive output span.
    pub rate: f64,
}

/// A punch-in over a stretch of the clip.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ZoomEffect {
    pub start_ms: u64,
    pub end_ms: u64,
    pub rect: PhysRect,
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
    /// The timeline's source-to-output map. Empty means the plain case --
    /// the whole trim at `speed`, which is what every export sent before
    /// timeline effects existed.
    #[serde(default)]
    pub plan: Vec<PlanSegment>,
    #[serde(default)]
    pub zooms: Vec<ZoomEffect>,
}

impl VideoExportRequest {
    /// Where a source moment lands in the output, or `None` when it was cut.
    fn map_to_output(&self, src_ms: f64) -> Option<f64> {
        if self.plan.is_empty() {
            // No timeline effects: the old single-speed behaviour.
            let speed = (self.speed as f64).max(0.01);
            return Some((src_ms - self.range.start_ms as f64).max(0.0) / speed);
        }
        for seg in &self.plan {
            if seg.rate <= 0.0 {
                continue;
            }
            if src_ms >= seg.src_start_ms && src_ms < seg.src_end_ms {
                return Some(seg.out_start_ms + (src_ms - seg.src_start_ms) / seg.rate);
            }
        }
        // The trim's final instant belongs to the last playing segment.
        let last = self.plan.iter().rev().find(|s| s.rate > 0.0)?;
        if (src_ms - last.src_end_ms).abs() < 0.5 {
            return Some(last.out_end_ms);
        }
        None
    }

    fn out_duration_ms(&self) -> u64 {
        if self.plan.is_empty() {
            let speed = (self.speed as f64).max(0.01);
            return ((self.range.duration_ms() as f64) / speed) as u64;
        }
        self.plan
            .iter()
            .map(|s| s.out_end_ms)
            .fold(0.0f64, f64::max) as u64
    }

    fn zoom_at(&self, src_ms: u64) -> Option<PhysRect> {
        // Later wins, so a zoom drawn over another behaves like the top one.
        self.zooms
            .iter()
            .rev()
            .find(|z| src_ms >= z.start_ms && src_ms < z.end_ms)
            .map(|z| z.rect)
    }
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
    let overlays = decode_overlays(parse_overlays(&bytes)?, req.crop)?;

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
        run_export(&worker_app, &src, &worker_dest, &req, overlays)
    })
    .await
    .map_err(|e| CommandError::Image(e.to_string()))??;

    crate::export::notify_saved(&app, &saved.to_string_lossy());
    crate::history::record_saved_video(&app, &saved);
    Ok(VideoExportResult {
        saved_path: saved.to_string_lossy().into_owned(),
    })
}

/// One flattened overlay and the stretch of the clip it covers.
pub struct OverlaySegment {
    pub range: TimeRange,
    pub image: RgbaImage,
}

/// Magic for the multi-overlay container. A body that does not start with it
/// is a single PNG covering the whole clip -- which is what every export sent
/// before time ranges existed, and what a clip with no time-ranged element
/// still sends.
const OVERLAY_MAGIC: &[u8; 4] = b"SSOV";

/// Parses the raw request body into overlays.
///
/// Several overlays have to share one body because a Tauri command takes
/// either a JSON payload or a raw one, never both, and the JSON half is
/// already carrying the export options. The container is deliberately dull:
/// magic, a count, then per segment a start, an end, a length and the PNG.
fn parse_overlays(bytes: &[u8]) -> CommandResult<Vec<(TimeRange, Vec<u8>)>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() < 4 || &bytes[..4] != OVERLAY_MAGIC {
        // A bare PNG: one overlay, the whole clip.
        return Ok(vec![(
            TimeRange {
                start_ms: 0,
                end_ms: u64::MAX,
            },
            bytes.to_vec(),
        )]);
    }

    let bad = || CommandError::Image("that overlay bundle is malformed".into());
    let mut at = 4usize;
    let read_u32 = |at: &mut usize| -> Option<u32> {
        let end = at.checked_add(4)?;
        let v = u32::from_le_bytes(bytes.get(*at..end)?.try_into().ok()?);
        *at = end;
        Some(v)
    };
    let read_u64 = |at: &mut usize| -> Option<u64> {
        let end = at.checked_add(8)?;
        let v = u64::from_le_bytes(bytes.get(*at..end)?.try_into().ok()?);
        *at = end;
        Some(v)
    };

    let count = read_u32(&mut at).ok_or_else(bad)? as usize;
    // A count far past what the body could hold means a corrupt header, not a
    // huge allocation.
    if count > 4096 {
        return Err(bad());
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let start_ms = read_u64(&mut at).ok_or_else(bad)?;
        let end_ms = read_u64(&mut at).ok_or_else(bad)?;
        let len = read_u32(&mut at).ok_or_else(bad)? as usize;
        let end = at.checked_add(len).ok_or_else(bad)?;
        let png = bytes.get(at..end).ok_or_else(bad)?.to_vec();
        at = end;
        out.push((TimeRange { start_ms, end_ms }, png));
    }
    Ok(out)
}

/// Decodes the parsed overlays, cropping each to match the frames.
fn decode_overlays(
    parsed: Vec<(TimeRange, Vec<u8>)>,
    crop: Option<PhysRect>,
) -> CommandResult<Vec<OverlaySegment>> {
    parsed
        .into_iter()
        .map(|(range, png)| {
            let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                .map_err(|e| CommandError::Image(e.to_string()))?
                .to_rgba8();
            Ok(OverlaySegment {
                range,
                image: match crop {
                    Some(crop) => transform::crop(&image, crop),
                    None => image,
                },
            })
        })
        .collect()
}

/// The crop-relative form of everything the export applies per frame.
///
/// The editor works in the *source* clip's coordinates -- a censor at (100,
/// 100) means 100px into the recording, and the overlay PNG is drawn at the
/// recording's own size. Shifting the censors and cropping the overlay to
/// match is done once here rather than per frame.
struct Prepared {
    censors: Vec<Censor>,
    /// One entry when nothing is time-ranged; one per segment otherwise.
    overlays: Vec<OverlaySegment>,
    output: (u32, u32),
}

impl Prepared {
    fn new(req: &VideoExportRequest, overlays: Vec<OverlaySegment>) -> Self {
        let (dx, dy) = req.crop.map(|c| (c.x, c.y)).unwrap_or((0, 0));
        let censors = req
            .censors
            .iter()
            .map(|c| Censor {
                rect: PhysRect::new(c.rect.x - dx, c.rect.y - dy, c.rect.w, c.rect.h),
                mode: c.mode,
                start_ms: c.start_ms,
                end_ms: c.end_ms,
            })
            .collect();
        Self {
            censors,
            overlays,
            output: req.output_size,
        }
    }

    /// The overlay covering `ms`, if any. Segments do not overlap, so the
    /// first match is the only one.
    fn overlay_at(&self, ms: u64) -> Option<&RgbaImage> {
        self.overlays
            .iter()
            .find(|o| ms >= o.range.start_ms && ms < o.range.end_ms)
            .map(|o| &o.image)
    }

    /// Convenience for a single whole-clip overlay, which is what an export
    /// with no time ranges builds. Used by the tests; the commands go through
    /// `parse_overlays`, which produces the same thing from a bare PNG.
    #[cfg(test)]
    fn whole_clip(req: &VideoExportRequest, overlay: Option<&RgbaImage>) -> Self {
        let overlays = overlay
            .map(|o| {
                vec![OverlaySegment {
                    range: TimeRange {
                        start_ms: 0,
                        end_ms: u64::MAX,
                    },
                    image: match req.crop {
                        Some(crop) => transform::crop(o, crop),
                        None => o.clone(),
                    },
                }]
            })
            .unwrap_or_default();
        Self::new(req, overlays)
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
fn process_frame(
    frame: &mut RgbaImage,
    prepared: &Prepared,
    crop: Option<PhysRect>,
    at_ms: u64,
    zoom: Option<PhysRect>,
) {
    // A zoom is just a tighter crop for the moments it covers, and it wins
    // over the export's own crop rather than stacking with it -- two crops
    // composed would make the punch-in depend on where the export crop
    // happened to be.
    if let Some(rect) = zoom.or(crop) {
        *frame = transform::crop(frame, rect);
    }
    if !prepared.censors.is_empty() {
        transform::apply_censors_at(frame, &prepared.censors, Some(at_ms));
    }
    if let Some(overlay) = prepared.overlay_at(at_ms) {
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
    overlays: Vec<OverlaySegment>,
) -> CommandResult<PathBuf> {
    let backend = crate::record::default_backend();
    let total_ms = req.range.duration_ms().max(1);
    let prepared = Prepared::new(req, overlays);

    match req.format {
        VideoFormat::Mp4 => {
            // The shim time-stretches audio by one uniform rate, which a
            // piecewise timeline has no equivalent of -- a cut or a freeze
            // would leave the sound running past the picture. So audio rides
            // along only for the plain single-speed case, and the editor says
            // so before you export.
            let uniform = req.plan.is_empty();
            // The shim ends the output timeline at `trim_duration / speed`,
            // so with a piecewise plan -- where a cut makes the output
            // *shorter* than that -- it would hold the closing frame to pad
            // the difference. Handing it the ratio the plan actually produces
            // keeps that calculation right. Audio is off in this case anyway,
            // which is the parameter's only other use.
            let out_ms = req.out_duration_ms().max(1) as f32;
            let effective_speed = if uniform {
                req.speed
            } else {
                (req.range.duration_ms().max(1) as f32) / out_ms
            };
            let opts = TranscodeOptions {
                range: req.range,
                speed: effective_speed,
                crop: req.crop,
                output: req.output_size,
                keep_audio: req.keep_audio && uniform,
            };
            let mut last_report = 0u64;
            backend
                .transcode(src, dest, &opts, &mut |mut frame| {
                    // Transcode hands over *trim-relative* times, while the
                    // editor sets time ranges against the whole clip -- so the
                    // trim's start goes back on before anything is matched.
                    // (`decode_frames`, used by the GIF branch below, gives
                    // absolute times already.)
                    let at_ms = req.range.start_ms + frame.pts_ms;
                    // A cut range simply produces no frame, which is what
                    // makes everything after it move earlier.
                    let out_ms = req.map_to_output(at_ms as f64)?;
                    process_frame(
                        &mut frame.image,
                        &prepared,
                        req.crop,
                        at_ms,
                        req.zoom_at(at_ms),
                    );
                    let elapsed = frame.pts_ms;
                    frame.pts_ms = out_ms.max(0.0) as u64;
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
            // Fast stretches need more source frames than the output rate to
            // stay smooth, so the decode runs at the highest rate the plan
            // asks for anywhere.
            let fastest = req
                .plan
                .iter()
                .map(|s| s.rate)
                .fold(req.speed as f64, f64::max)
                .max(1.0);
            let src_fps = ((fps as f64 * fastest).round() as u32).clamp(1, 120);

            // Collected with the output time each frame lands at, then
            // resampled onto an even grid below. A GIF carries an explicit
            // delay per frame, so a freeze has to become repeated frames --
            // unlike the MP4 path, where a gap in timestamps holds the last
            // one on screen by itself.
            let mut timed: Vec<(f64, RgbaImage)> = Vec::new();
            let mut last_report = 0u64;
            backend
                .decode_frames(src, req.range, src_fps, &mut |mut frame| {
                    // Already absolute clip time, unlike the transcode path.
                    let Some(out_ms) = req.map_to_output(frame.pts_ms as f64) else {
                        return true; // cut
                    };
                    process_frame(
                        &mut frame.image,
                        &prepared,
                        req.crop,
                        frame.pts_ms,
                        req.zoom_at(frame.pts_ms),
                    );
                    if frame.image.dimensions() != gif_size {
                        frame.image = transform::resize(&frame.image, gif_size.0, gif_size.1);
                    }
                    timed.push((out_ms, frame.image));
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

            let frames = resample_to_output(timed, fps, req.out_duration_ms());
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

/// Puts frames carrying output timestamps onto an even 1/fps grid.
///
/// Each slot shows the most recent frame at or before it, so a freeze (whose
/// source frames all land at one output moment, followed by a gap) repeats
/// that frame for as long as the hold lasts, and a fast stretch drops the
/// frames it does not need.
fn resample_to_output(
    timed: Vec<(f64, RgbaImage)>,
    fps: u32,
    out_duration_ms: u64,
) -> Vec<RgbaImage> {
    if timed.is_empty() {
        return Vec::new();
    }
    let interval = 1000.0 / fps.max(1) as f64;
    // The frames arrive in source order, which is output order too: the plan
    // is monotonic by construction.
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let mut slot = 0.0f64;
    let end = out_duration_ms as f64;
    // Guard against a pathological plan asking for a million frames.
    let cap = 20_000usize;

    while slot <= end && out.len() < cap {
        while cursor + 1 < timed.len() && timed[cursor + 1].0 <= slot + 1e-6 {
            cursor += 1;
        }
        out.push(timed[cursor].1.clone());
        slot += interval;
    }
    out
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

/// Standard base64 with padding, for `data:` URIs.
///
/// Hand-rolled rather than adding a crate: `drive.rs` already carries a
/// URL-safe variant for the same reason, and this is the only other place
/// that needs one.
fn base64_standard(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        // The tail is padded rather than truncated: a decoder that expects
        // padding rejects the whole string otherwise.
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Evenly spaced thumbnails across a recording, as PNG bytes, for the
/// timeline's filmstrip.
///
/// Decoded here rather than by seeking a `<video>` repeatedly in the webview:
/// a dozen seeks on a long clip is slow and stutters playback, while one
/// decode pass over the whole range is cheap.
#[tauri::command]
pub async fn video_thumbnails(
    app: AppHandle,
    id: String,
    count: u32,
    height: u32,
) -> CommandResult<Vec<String>> {
    let path = app
        .state::<VideoStore>()
        .get(&id)
        .ok_or_else(|| CommandError::Image("that recording is no longer open".into()))?;

    tauri::async_runtime::spawn_blocking(move || {
        let backend = crate::record::default_backend();
        let info = backend
            .probe(&path)
            .map_err(|e| CommandError::Image(e.to_string()))?;
        let count = count.clamp(1, 40);
        let height = height.clamp(16, 200);
        let width = ((info.width as f64) * (height as f64) / (info.height.max(1) as f64))
            .round()
            .max(1.0) as u32;

        // One frame per slot across the whole clip: the decoder already paces
        // to a requested rate and holds frames across gaps, so asking for
        // `count` over the duration gives evenly spaced stills.
        let range = TimeRange {
            start_ms: 0,
            end_ms: info.duration_ms.max(1),
        };
        let fps = ((count as f64 * 1000.0) / info.duration_ms.max(1) as f64).ceil() as u32;

        let mut out = Vec::new();
        backend
            .decode_frames(&path, range, fps.max(1), &mut |frame| {
                if out.len() >= count as usize {
                    return false;
                }
                let small = transform::resize(&frame.image, width, height);
                let mut png = Vec::new();
                if small
                    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .is_ok()
                {
                    out.push(format!("data:image/png;base64,{}", base64_standard(&png)));
                }
                true
            })
            .map_err(|e| CommandError::Image(e.to_string()))?;
        Ok(out)
    })
    .await
    .map_err(|e| CommandError::Image(e.to_string()))?
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

    let overlays = decode_overlays(parse_overlays(&bytes)?, req.crop)?;
    let temp = std::env::temp_dir().join(format!("slickshot-upload-{}.mp4", uuid::Uuid::new_v4()));
    let worker_app = app.clone();
    let worker_temp = temp.clone();
    let built = tauri::async_runtime::spawn_blocking(move || {
        run_export(&worker_app, &src, &worker_temp, &req, overlays)
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

    let overlays = decode_overlays(parse_overlays(&bytes)?, req.crop)?;
    let info = crate::record::default_backend()
        .probe(&src)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    if is_untouched(&req, &info) && overlays.is_empty() {
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
        run_export(&worker_app, &src, &worker_dest, &req, overlays)
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
            plan: Vec::new(),
            zooms: Vec::new(),
        }
    }

    #[test]
    fn a_frame_is_cropped_then_resized_to_the_output() {
        let mut frame = RgbaImage::from_pixel(100, 80, image::Rgba([10, 20, 30, 255]));
        let mut req = request((20, 20));
        req.crop = Some(PhysRect::new(10, 10, 40, 40));
        process_frame(&mut frame, &Prepared::whole_clip(&req, None), req.crop, 0, None);
        assert_eq!(frame.dimensions(), (20, 20), "the output size wins");
    }

    #[test]
    fn a_frame_with_no_crop_is_still_resized() {
        let mut frame = RgbaImage::from_pixel(64, 64, image::Rgba([1, 2, 3, 255]));
        let req = request((32, 16));
        process_frame(&mut frame, &Prepared::whole_clip(&req, None), None, 0, None);
        assert_eq!(frame.dimensions(), (32, 16));
    }

    #[test]
    fn the_overlay_goes_on_last_so_censors_cannot_cover_it() {
        // A censor over the whole frame, and an opaque overlay pixel on top:
        // if the order were reversed the overlay would be blacked out.
        let mut frame = RgbaImage::from_pixel(8, 8, image::Rgba([200, 200, 200, 255]));
        let mut req = request((8, 8));
        req.censors = vec![Censor {
                start_ms: None,
                end_ms: None,
            rect: PhysRect::new(0, 0, 8, 8),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let mut overlay = RgbaImage::from_pixel(8, 8, image::Rgba([0, 0, 0, 0]));
        overlay.put_pixel(2, 2, image::Rgba([255, 0, 0, 255]));

        process_frame(&mut frame, &Prepared::whole_clip(&req, Some(&overlay)), None, 0, None);
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
                start_ms: None,
                end_ms: None,
            rect: PhysRect::new(60, 60, 20, 20),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let prepared = Prepared::whole_clip(&req, None);
        process_frame(&mut frame, &prepared, req.crop, 0, None);

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

        let prepared = Prepared::whole_clip(&req, Some(&overlay));
        process_frame(&mut frame, &prepared, req.crop, 0, None);
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
                start_ms: None,
                end_ms: None,
            rect: PhysRect::new(0, 0, 100, 100),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let prepared = Prepared::whole_clip(&req, None);
        process_frame(&mut frame, &prepared, None, 0, None);

        assert_eq!(frame.dimensions(), (100, 100));
        // The censored top-left quarter of the source is the top-left quarter
        // of the output too.
        assert_eq!(frame.get_pixel(20, 20).0, [0, 0, 0, 255]);
        assert_eq!(frame.get_pixel(70, 70).0, [255, 255, 255, 255]);
    }

    fn bundle(parts: &[(u64, u64, &[u8])]) -> Vec<u8> {
        let mut out = OVERLAY_MAGIC.to_vec();
        out.extend_from_slice(&(parts.len() as u32).to_le_bytes());
        for (start, end, png) in parts {
            out.extend_from_slice(&start.to_le_bytes());
            out.extend_from_slice(&end.to_le_bytes());
            out.extend_from_slice(&(png.len() as u32).to_le_bytes());
            out.extend_from_slice(png);
        }
        out
    }

    #[test]
    fn an_empty_body_means_no_overlay() {
        assert!(parse_overlays(&[]).expect("parse").is_empty());
    }

    #[test]
    fn a_bare_png_is_one_whole_clip_overlay() {
        // What every export sent before time ranges existed, and what a clip
        // with no time-ranged element still sends.
        let png = b"\x89PNG\r\n\x1a\n rest".to_vec();
        let out = parse_overlays(&png).expect("parse");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0.start_ms, 0);
        assert_eq!(out[0].0.end_ms, u64::MAX);
        assert_eq!(out[0].1, png);
    }

    #[test]
    fn a_bundle_round_trips_its_segments() {
        let body = bundle(&[(0, 1000, b"first"), (1000, 4000, b"second")]);
        let out = parse_overlays(&body).expect("parse");
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].0.start_ms, out[0].0.end_ms), (0, 1000));
        assert_eq!(out[0].1, b"first");
        assert_eq!((out[1].0.start_ms, out[1].0.end_ms), (1000, 4000));
        assert_eq!(out[1].1, b"second");
    }

    #[test]
    fn a_truncated_bundle_is_an_error_not_a_panic() {
        let body = bundle(&[(0, 1000, b"first")]);
        for cut in [5, 8, 12, body.len() - 1] {
            assert!(
                parse_overlays(&body[..cut]).is_err(),
                "a body cut at {cut} should be refused"
            );
        }
    }

    #[test]
    fn an_absurd_segment_count_is_refused() {
        // A corrupt header should not turn into a huge allocation.
        let mut body = OVERLAY_MAGIC.to_vec();
        body.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse_overlays(&body).is_err());
    }

    #[test]
    fn a_censor_applies_only_inside_its_time_range() {
        let mut req = request((8, 8));
        req.censors = vec![Censor {
            rect: PhysRect::new(0, 0, 8, 8),
            start_ms: Some(1_000),
            end_ms: Some(2_000),
            mode: crate::record::transform::CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let prepared = Prepared::new(&req, Vec::new());

        for (at, censored) in [(0u64, false), (999, false), (1_000, true), (1_999, true), (2_000, false)] {
            let mut frame = RgbaImage::from_pixel(8, 8, image::Rgba([255, 255, 255, 255]));
            process_frame(&mut frame, &prepared, None, at, None);
            let black = frame.get_pixel(4, 4).0 == [0, 0, 0, 255];
            assert_eq!(black, censored, "at {at}ms");
        }
    }

    #[test]
    fn the_overlay_for_a_frame_is_the_segment_covering_it() {
        let req = request((4, 4));
        let red = RgbaImage::from_pixel(4, 4, image::Rgba([255, 0, 0, 255]));
        let blue = RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 255, 255]));
        let prepared = Prepared::new(
            &req,
            vec![
                OverlaySegment {
                    range: TimeRange { start_ms: 0, end_ms: 1_000 },
                    image: red,
                },
                OverlaySegment {
                    range: TimeRange { start_ms: 1_000, end_ms: 2_000 },
                    image: blue,
                },
            ],
        );

        for (at, expect) in [(0u64, [255, 0, 0, 255]), (999, [255, 0, 0, 255]), (1_000, [0, 0, 255, 255])] {
            let mut frame = RgbaImage::from_pixel(4, 4, image::Rgba([10, 10, 10, 255]));
            process_frame(&mut frame, &prepared, None, at, None);
            assert_eq!(frame.get_pixel(1, 1).0, expect, "at {at}ms");
        }

        // Past every segment: the frame is left alone rather than keeping the
        // last overlay on screen forever.
        let mut frame = RgbaImage::from_pixel(4, 4, image::Rgba([10, 10, 10, 255]));
        process_frame(&mut frame, &prepared, None, 5_000, None);
        assert_eq!(frame.get_pixel(1, 1).0, [10, 10, 10, 255]);
    }

    fn planned(plan: Vec<PlanSegment>) -> VideoExportRequest {
        let mut req = request((8, 8));
        req.range = TimeRange { start_ms: 0, end_ms: 10_000 };
        req.plan = plan;
        req
    }

    fn seg(src: (f64, f64), out: (f64, f64), rate: f64) -> PlanSegment {
        PlanSegment {
            src_start_ms: src.0,
            src_end_ms: src.1,
            out_start_ms: out.0,
            out_end_ms: out.1,
            rate,
        }
    }

    #[test]
    fn an_empty_plan_is_the_old_single_speed_behaviour() {
        let mut req = request((8, 8));
        req.range = TimeRange { start_ms: 1_000, end_ms: 5_000 };
        req.speed = 2.0;
        // Trim-relative and divided by the speed, exactly as before.
        assert_eq!(req.map_to_output(1_000.0), Some(0.0));
        assert_eq!(req.map_to_output(3_000.0), Some(1_000.0));
        assert_eq!(req.out_duration_ms(), 2_000);
    }

    #[test]
    fn a_cut_range_maps_to_nothing() {
        // 0-2s plays, 2-4s is cut, 4-10s plays and starts right after.
        let req = planned(vec![
            seg((0.0, 2_000.0), (0.0, 2_000.0), 1.0),
            seg((4_000.0, 10_000.0), (2_000.0, 8_000.0), 1.0),
        ]);
        assert_eq!(req.map_to_output(1_000.0), Some(1_000.0));
        assert_eq!(req.map_to_output(3_000.0), None, "inside the cut");
        assert_eq!(req.map_to_output(5_000.0), Some(3_000.0));
        assert_eq!(req.out_duration_ms(), 8_000);
    }

    #[test]
    fn a_freeze_segment_consumes_no_source() {
        // A freeze is a zero-rate segment; source moments must never map into
        // it, or every frame during the hold would land on one timestamp.
        let req = planned(vec![
            seg((0.0, 4_000.0), (0.0, 4_000.0), 1.0),
            seg((4_000.0, 4_000.0), (4_000.0, 6_000.0), 0.0),
            seg((4_000.0, 10_000.0), (6_000.0, 12_000.0), 1.0),
        ]);
        assert_eq!(req.map_to_output(4_500.0), Some(6_500.0));
        assert_eq!(req.out_duration_ms(), 12_000);
    }

    #[test]
    fn a_speed_segment_compresses_only_its_own_span() {
        let req = planned(vec![
            seg((0.0, 2_000.0), (0.0, 2_000.0), 1.0),
            seg((2_000.0, 6_000.0), (2_000.0, 4_000.0), 2.0),
            seg((6_000.0, 10_000.0), (4_000.0, 8_000.0), 1.0),
        ]);
        assert_eq!(req.map_to_output(4_000.0), Some(3_000.0));
        assert_eq!(req.map_to_output(7_000.0), Some(5_000.0));
    }

    #[test]
    fn the_last_instant_of_the_plan_still_maps() {
        let req = planned(vec![seg((0.0, 10_000.0), (0.0, 10_000.0), 1.0)]);
        assert_eq!(req.map_to_output(10_000.0), Some(10_000.0));
        assert_eq!(req.map_to_output(11_000.0), None);
    }

    #[test]
    fn a_zoom_applies_only_inside_its_range() {
        let mut req = request((8, 8));
        req.zooms = vec![ZoomEffect {
            start_ms: 1_000,
            end_ms: 3_000,
            rect: PhysRect::new(10, 20, 30, 40),
        }];
        assert!(req.zoom_at(999).is_none());
        assert_eq!(req.zoom_at(2_000), Some(PhysRect::new(10, 20, 30, 40)));
        assert!(req.zoom_at(3_000).is_none());
    }

    #[test]
    fn a_zoom_crops_instead_of_the_export_crop() {
        // Two crops composed would make the punch-in depend on where the
        // export crop happened to be, so the zoom replaces it.
        let mut frame = RgbaImage::from_pixel(100, 100, image::Rgba([255, 255, 255, 255]));
        let mut req = request((20, 20));
        req.crop = Some(PhysRect::new(0, 0, 80, 80));
        let prepared = Prepared::new(&req, Vec::new());
        process_frame(
            &mut frame,
            &prepared,
            req.crop,
            0,
            Some(PhysRect::new(10, 10, 40, 40)),
        );
        assert_eq!(frame.dimensions(), (20, 20));
    }

    #[test]
    fn resampling_repeats_a_held_frame_and_stops_at_the_end() {
        let red = RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
        let blue = RgbaImage::from_pixel(2, 2, image::Rgba([0, 0, 255, 255]));
        // One frame at 0, the next only at 1000ms: a one-second hold.
        let out = resample_to_output(vec![(0.0, red), (1_000.0, blue)], 10, 2_000);
        assert_eq!(out.len(), 21, "10fps over 2s, inclusive of both ends");
        assert_eq!(out[0].get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(out[9].get_pixel(0, 0).0, [255, 0, 0, 255], "still held at 900ms");
        assert_eq!(out[10].get_pixel(0, 0).0, [0, 0, 255, 255], "swaps at 1000ms");
    }

    #[test]
    fn resampling_an_empty_decode_yields_nothing() {
        assert!(resample_to_output(Vec::new(), 10, 1_000).is_empty());
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        // The RFC 4648 vectors -- a data: URI is rejected outright if the
        // padding is wrong, and that failure looks like "the image is broken".
        assert_eq!(base64_standard(b""), "");
        assert_eq!(base64_standard(b"f"), "Zg==");
        assert_eq!(base64_standard(b"fo"), "Zm8=");
        assert_eq!(base64_standard(b"foo"), "Zm9v");
        assert_eq!(base64_standard(b"foob"), "Zm9vYg==");
        assert_eq!(base64_standard(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_standard(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_covers_the_high_bytes() {
        assert_eq!(base64_standard(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_standard(&[0x00, 0x00, 0x00]), "AAAA");
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
