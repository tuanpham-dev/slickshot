//! Linux recording backend: `xcap` frames pushed through a GStreamer
//! pipeline.
//!
//! GStreamer rather than a direct encoder binding because it is the only thing
//! on Linux that reliably finds *some* H.264 encoder across distributions --
//! VA-API on Intel/AMD, x264 or openh264 elsewhere -- without this app
//! shipping its own. It is a runtime dependency, so `engine_status` reports
//! plainly when it is missing instead of the Record button failing silently.
//!
//! **Unverified.** This has never been compiled: cross-checking from the
//! development machine fails inside `libdbus-sys`, which needs pkg-config.
//! See the T5.3 checklist in `docs/TESTING.md`.

use std::path::Path;

#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
#[cfg(target_os = "linux")]
use image::RgbaImage;

use super::{
    ActiveRecording, RecordConfig, RecordError, RecordResult, RgbaFrame, TimeRange,
    TranscodeOptions, VideoBackend, VideoInfo,
};

#[cfg(target_os = "linux")]
use gstreamer as gst;
#[cfg(target_os = "linux")]
use gstreamer::prelude::*;
#[cfg(target_os = "linux")]
use gstreamer_app as gst_app;

pub struct LinuxBackend;

/// Whether recording can work here, and why not when it cannot.
#[derive(Debug, Clone)]
pub struct EngineStatus {
    pub available: bool,
    pub reason: String,
}

/// An H.264 encoder this can record with.
struct Encoder {
    name: &'static str,
    /// The element as it goes into a launch description.
    launch: &'static str,
    /// The raw format it is fed. Always 4:2:0: left to negotiate, x264enc
    /// takes RGBA as Y444 and writes High 4:4:4, which openh264, VA-API,
    /// browsers and most players refuse -- the editor's own preview included.
    /// The VA encoders only accept NV12.
    format: &'static str,
    /// Hardware encoders are probed before use: the element being registered
    /// says nothing about whether this GPU and driver can actually encode.
    hardware: bool,
}

/// The encoders this looks for, best first. `vah264enc` is the current VA
/// plugin; `vaapih264enc` is the older gstreamer-vaapi one it replaced, still
/// what some distributions ship. x264enc is tuned for low latency because
/// this is a live capture, not a file conversion.
const ENCODERS: [Encoder; 4] = [
    Encoder { name: "vah264enc", launch: "vah264enc", format: "NV12", hardware: true },
    Encoder { name: "vaapih264enc", launch: "vaapih264enc", format: "NV12", hardware: true },
    Encoder {
        name: "x264enc",
        launch: "x264enc speed-preset=veryfast tune=zerolatency",
        format: "I420",
        hardware: false,
    },
    Encoder { name: "openh264enc", launch: "openh264enc", format: "I420", hardware: false },
];

#[cfg(target_os = "linux")]
pub fn engine_status() -> EngineStatus {
    if let Err(e) = gst::init() {
        return EngineStatus {
            available: false,
            reason: format!("GStreamer wouldn't start: {e}"),
        };
    }
    let found = available_encoders();
    if found.is_empty() {
        return EngineStatus {
            available: false,
            reason: "No H.264 encoder found. Install gstreamer1.0-plugins-ugly (x264), or \
                     the VA plugin (gstreamer1.0-plugins-bad) for hardware encoding."
                .into(),
        };
    }
    EngineStatus {
        available: true,
        reason: format!("Recording with {}", found.join(", ")),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn engine_status() -> EngineStatus {
    EngineStatus {
        available: true,
        reason: String::new(),
    }
}

/// The encoders that are installed and, for hardware ones, actually work.
/// Worked out once: the probe starts a pipeline per hardware encoder.
#[cfg(target_os = "linux")]
fn available_encoders() -> Vec<&'static str> {
    static FOUND: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    FOUND
        .get_or_init(|| {
            let registry = gst::Registry::get();
            ENCODERS
                .iter()
                .filter(|e| {
                    registry
                        .find_feature(e.name, gst::ElementFactory::static_type())
                        .is_some()
                })
                .filter(|e| !e.hardware || encoder_works(e))
                .map(|e| e.name)
                .collect()
        })
        .clone()
}

/// Encodes a few test frames through `encoder`. A VA encoder registers
/// whenever a VA device exists, including one whose driver has no H.264
/// encode entrypoint -- and that only shows up as an error mid-recording.
#[cfg(target_os = "linux")]
fn encoder_works(encoder: &Encoder) -> bool {
    let desc = format!(
        "videotestsrc num-buffers=3 ! video/x-raw,format={},width=320,height=240,framerate=30/1 \
         ! {} ! h264parse ! fakesink",
        encoder.format, encoder.launch
    );
    let Ok(pipeline) = gst::parse::launch(&desc) else {
        return false;
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        let _ = pipeline.set_state(gst::State::Null);
        return false;
    }
    let mut ok = false;
    if let Some(bus) = pipeline.bus() {
        for msg in bus.iter_timed(gst::ClockTime::from_seconds(5)) {
            match msg.view() {
                gst::MessageView::Eos(_) => {
                    ok = true;
                    break;
                }
                gst::MessageView::Error(_) => break,
                _ => {}
            }
        }
    }
    let _ = pipeline.set_state(gst::State::Null);
    ok
}

/// Reads one screen region straight off the X server, in the server's own
/// 32-bit BGRx layout.
///
/// Instead of `xcap`'s video recorder, which grabs the *whole monitor* in an
/// unpaced loop, converts every pixel to RGBA and queues each frame on an
/// unbounded channel: at 4K that is over 30MB a frame the recording then
/// copied and cropped again, and when it fell behind the queue grew and the
/// frames were stamped when they were read rather than when they were taken.
#[cfg(target_os = "linux")]
struct RegionGrabber {
    conn: x11rb::rust_connection::RustConnection,
    root: u32,
    x: i16,
    y: i16,
    w: u16,
    h: u16,
}

#[cfg(target_os = "linux")]
impl RegionGrabber {
    fn new(x: i32, y: i32, w: u32, h: u32) -> RecordResult<Self> {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::ImageOrder;

        let (conn, screen_num) =
            x11rb::connect(None).map_err(|e| RecordError::Backend(e.to_string()))?;
        let setup = conn.setup();
        let screen = &setup.roots[screen_num];
        // GetImage hands back the server's pixel layout as-is; BGRx is what
        // every depth-24/32 TrueColor server in practice uses, and anything
        // else would need a conversion this doesn't have.
        let packed_32 = setup
            .pixmap_formats
            .iter()
            .any(|f| f.depth == screen.root_depth && f.bits_per_pixel == 32);
        if !matches!(screen.root_depth, 24 | 32)
            || !packed_32
            || setup.image_byte_order != ImageOrder::LSB_FIRST
        {
            return Err(RecordError::Unsupported(format!(
                "recording needs a 24-bit little-endian display (this one is {}-bit)",
                screen.root_depth
            )));
        }
        let fits = x >= 0
            && y >= 0
            && x as i64 + w as i64 <= screen.width_in_pixels as i64
            && y as i64 + h as i64 <= screen.height_in_pixels as i64;
        if !fits {
            return Err(RecordError::Backend("that region is off the screen".into()));
        }
        let root = screen.root;
        Ok(Self {
            conn,
            root,
            x: x as i16,
            y: y as i16,
            w: w as u16,
            h: h as u16,
        })
    }

    fn grab(&self) -> Option<Vec<u8>> {
        use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat};

        let reply = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, self.x, self.y, self.w, self.h, !0)
            .ok()?
            .reply()
            .ok()?;
        (reply.data.len() == self.w as usize * self.h as usize * 4).then_some(reply.data)
    }
}

/// A recording in flight: the pipeline, plus the capture thread's stop flag.
#[cfg(target_os = "linux")]
struct LinuxRecording {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    running: Arc<AtomicBool>,
    started: Instant,
    out_path: std::path::PathBuf,
    capture: Option<std::thread::JoinHandle<()>>,
    warnings: Vec<String>,
}

#[cfg(target_os = "linux")]
impl ActiveRecording for LinuxRecording {
    fn stop(mut self: Box<Self>) -> RecordResult<std::path::PathBuf> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture.take() {
            let _ = handle.join();
        }
        // EOS then wait: without it mp4mux never writes the moov atom and the
        // file is unplayable.
        let _ = self.appsrc.end_of_stream();
        let bus = self
            .pipeline
            .bus()
            .ok_or_else(|| RecordError::Backend("the pipeline has no bus".into()))?;
        for msg in bus.iter_timed(gst::ClockTime::from_seconds(10)) {
            match msg.view() {
                gst::MessageView::Eos(_) => break,
                gst::MessageView::Error(e) => {
                    let _ = self.pipeline.set_state(gst::State::Null);
                    return Err(RecordError::Backend(e.error().to_string()));
                }
                _ => {}
            }
        }
        let _ = self.pipeline.set_state(gst::State::Null);
        Ok(self.out_path.clone())
    }

    fn cancel(mut self: Box<Self>) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture.take() {
            let _ = handle.join();
        }
        let _ = self.pipeline.set_state(gst::State::Null);
        let _ = std::fs::remove_file(&self.out_path);
    }

    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }
}

impl VideoBackend for LinuxBackend {
    #[cfg(not(target_os = "linux"))]
    fn start_recording(&self, _cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        Err(RecordError::Unsupported("not Linux".into()))
    }

    #[cfg(target_os = "linux")]
    fn start_recording(&self, cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        let status = engine_status();
        if !status.available {
            return Err(RecordError::Unsupported(status.reason));
        }

        // H.264 wants even dimensions; an odd request fails inside the encoder
        // with a message that says nothing useful.
        let w = (cfg.rect.w & !1).max(2);
        let h = (cfg.rect.h & !1).max(2);
        let desc = pipeline_description(
            w,
            h,
            cfg.fps,
            "BGRx",
            &cfg.out_path.to_string_lossy(),
            &available_encoders(),
        )
        .ok_or_else(|| RecordError::Unsupported("no usable H.264 encoder".into()))?;

        let pipeline = gst::parse::launch(&desc)
            .map_err(|e| RecordError::Backend(e.to_string()))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| RecordError::Backend("that pipeline isn't a pipeline".into()))?;
        let appsrc = pipeline
            .by_name("src")
            .ok_or_else(|| RecordError::Backend("the pipeline has no appsrc".into()))?
            .downcast::<gst_app::AppSrc>()
            .map_err(|_| RecordError::Backend("`src` isn't an appsrc".into()))?;

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| RecordError::Backend(e.to_string()))?;

        // Opened here rather than on the capture thread so a display that
        // can't be read fails the start, instead of leaving an empty file.
        let grabber = match RegionGrabber::new(cfg.rect.x, cfg.rect.y, w, h) {
            Ok(g) => g,
            Err(e) => {
                let _ = pipeline.set_state(gst::State::Null);
                return Err(e);
            }
        };

        let running = Arc::new(AtomicBool::new(true));
        let started = Instant::now();

        let src = appsrc.clone();
        let flag = running.clone();
        let interval = Duration::from_secs_f64(1.0 / cfg.fps.max(1) as f64);
        let capture = std::thread::spawn(move || {
            // Paced here, one grab per slot, and stamped with when the grab
            // happened. A slot the grab overran is skipped rather than caught
            // up on, so a slow machine records at a lower rate with correct
            // timing instead of queueing frames and drifting behind.
            let mut next = started;
            while flag.load(Ordering::SeqCst) {
                let now = Instant::now();
                if now < next {
                    std::thread::sleep(next - now);
                    continue;
                }
                let pts = started.elapsed();
                let Some(pixels) = grabber.grab() else {
                    next += interval;
                    continue;
                };
                let mut buffer = gst::Buffer::from_mut_slice(pixels);
                buffer
                    .get_mut()
                    .expect("sole owner")
                    .set_pts(gst::ClockTime::from_nseconds(pts.as_nanos() as u64));
                if src.push_buffer(buffer).is_err() {
                    break;
                }
                next += interval;
                let after = Instant::now();
                while next < after {
                    next += interval;
                }
            }
        });

        Ok(Box::new(LinuxRecording {
            pipeline,
            appsrc,
            running,
            started,
            out_path: cfg.out_path.clone(),
            capture: Some(capture),
            // Audio has no Linux path, and X11's GetImage doesn't draw the cursor.
            warnings: if cfg.system_audio || cfg.microphone {
                vec!["Audio recording isn't available on Linux -- recording video only.".into()]
            } else {
                Vec::new()
            },
        }))
    }

    #[cfg(not(target_os = "linux"))]
    fn probe(&self, _path: &Path) -> RecordResult<VideoInfo> {
        Err(RecordError::Unsupported("not Linux".into()))
    }

    #[cfg(target_os = "linux")]
    fn probe(&self, path: &Path) -> RecordResult<VideoInfo> {
        gst::init().map_err(|e| RecordError::Backend(e.to_string()))?;
        let uri = uri_for(path)?;
        let discoverer = gstreamer_pbutils::Discoverer::new(gst::ClockTime::from_seconds(10))
            .map_err(|e| RecordError::Backend(e.to_string()))?;
        let info = discoverer
            .discover_uri(&uri)
            .map_err(|e| RecordError::Backend(e.to_string()))?;

        let video = info
            .video_streams()
            .into_iter()
            .next()
            .ok_or_else(|| RecordError::Backend("this file has no video track".into()))?;
        let audio_tracks = info.audio_streams().len() as u32;
        let fps = video.framerate();
        Ok(VideoInfo {
            width: video.width(),
            height: video.height(),
            duration_ms: info
                .duration()
                .map(|d| d.mseconds())
                .unwrap_or(0),
            fps: if fps.denom() != 0 {
                fps.numer() as f32 / fps.denom() as f32
            } else {
                0.0
            },
            has_audio: audio_tracks > 0,
            audio_tracks,
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn decode_frames(
        &self,
        _path: &Path,
        _range: TimeRange,
        _fps: u32,
        _on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        Err(RecordError::Unsupported("not Linux".into()))
    }

    #[cfg(target_os = "linux")]
    fn decode_frames(
        &self,
        path: &Path,
        range: TimeRange,
        fps: u32,
        on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        gst::init().map_err(|e| RecordError::Backend(e.to_string()))?;
        let uri = uri_for(path)?;
        let desc = format!(
            "uridecodebin uri={uri} ! videoconvert ! videoscale \
             ! appsink name=sink caps=video/x-raw,format=RGBA sync=false"
        );
        let pipeline = gst::parse::launch(&desc)
            .map_err(|e| RecordError::Backend(e.to_string()))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| RecordError::Backend("that pipeline isn't a pipeline".into()))?;
        let sink = pipeline
            .by_name("sink")
            .ok_or_else(|| RecordError::Backend("the pipeline has no appsink".into()))?
            .downcast::<gst_app::AppSink>()
            .map_err(|_| RecordError::Backend("`sink` isn't an appsink".into()))?;

        pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| RecordError::Backend(e.to_string()))?;
        // Seeking needs the pipeline prerolled, or the seek is dropped.
        let _ = pipeline.state(gst::ClockTime::from_seconds(5));
        let _ = pipeline.seek_simple(
            gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
            gst::ClockTime::from_mseconds(range.start_ms),
        );
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| RecordError::Backend(e.to_string()))?;

        // Same contract as the macOS decoder: an even 1/fps grid with the last
        // frame held across gaps, so a still stretch yields repeated frames
        // rather than none and an fps-based export keeps its timing.
        let interval_ms = if fps > 0 { 1000.0 / fps as f64 } else { 0.0 };
        let mut next_slot = range.start_ms as f64;
        let mut held: Option<RgbaImage> = None;
        let mut keep_going = true;

        while keep_going {
            let Ok(sample) = sink.pull_sample() else { break };
            let Some(buffer) = sample.buffer() else { continue };
            let pts_ms = buffer.pts().map(|t| t.mseconds()).unwrap_or(0);
            if pts_ms > range.end_ms {
                break;
            }
            let Some(caps) = sample.caps() else { continue };
            let Ok(vinfo) = gstreamer_video::VideoInfo::from_caps(caps) else {
                continue;
            };
            let Ok(map) = buffer.map_readable() else { continue };
            let Some(image) =
                RgbaImage::from_raw(vinfo.width(), vinfo.height(), map.as_slice().to_vec())
            else {
                continue;
            };

            if interval_ms > 0.0 {
                while keep_going && next_slot + 1e-9 < pts_ms as f64 {
                    if let Some(prev) = &held {
                        keep_going = on_frame(RgbaFrame {
                            image: prev.clone(),
                            pts_ms: next_slot as u64,
                        });
                    }
                    next_slot += interval_ms;
                }
                held = Some(image);
            } else {
                keep_going = on_frame(RgbaFrame { image, pts_ms });
            }
        }

        // The tail, for a clip that ends on a still frame.
        if keep_going && interval_ms > 0.0 {
            if let Some(prev) = held {
                while keep_going && next_slot + 1e-9 < range.end_ms as f64 {
                    keep_going = on_frame(RgbaFrame {
                        image: prev.clone(),
                        pts_ms: next_slot as u64,
                    });
                    next_slot += interval_ms;
                }
            }
        }

        let _ = pipeline.set_state(gst::State::Null);
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    fn transcode(
        &self,
        _src: &Path,
        _dst: &Path,
        _opts: &TranscodeOptions,
        _process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        Err(RecordError::Unsupported("not Linux".into()))
    }

    #[cfg(target_os = "linux")]
    fn transcode(
        &self,
        src: &Path,
        dst: &Path,
        opts: &TranscodeOptions,
        process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        gst::init().map_err(|e| RecordError::Backend(e.to_string()))?;
        let (out_w, out_h) = ((opts.output.0 & !1).max(2), (opts.output.1 & !1).max(2));
        let desc = pipeline_description(
            out_w,
            out_h,
            30,
            "RGBA",
            &dst.to_string_lossy(),
            &available_encoders(),
        )
        .ok_or_else(|| RecordError::Unsupported("no usable H.264 encoder".into()))?;

        let pipeline = gst::parse::launch(&desc)
            .map_err(|e| RecordError::Backend(e.to_string()))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| RecordError::Backend("that pipeline isn't a pipeline".into()))?;
        let appsrc = pipeline
            .by_name("src")
            .ok_or_else(|| RecordError::Backend("the pipeline has no appsrc".into()))?
            .downcast::<gst_app::AppSrc>()
            .map_err(|_| RecordError::Backend("`src` isn't an appsrc".into()))?;
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| RecordError::Backend(e.to_string()))?;

        // Audio is dropped rather than passed through: mp4mux would need a
        // second pad wired before the pipeline starts, and the speed change
        // would need a pitch-corrected time-stretch this platform has no
        // equivalent of. Documented as a macOS-only capability.
        let start = opts.range.start_ms;
        let mut failed: Option<String> = None;
        self.decode_frames(src, opts.range, 0, &mut |frame| {
            // Trim-relative *source* time: the caller maps it onto the output
            // timeline itself (speed, cuts, freezes) and hands back the pts to
            // encode at. Scaling by speed here as well applied it twice.
            let Some(processed) = process(RgbaFrame {
                image: frame.image,
                pts_ms: frame.pts_ms.saturating_sub(start),
            }) else {
                return true;
            };
            if processed.image.dimensions() != (out_w, out_h) {
                return true;
            }
            let mut buffer = gst::Buffer::from_mut_slice(processed.image.into_raw());
            {
                let buf = buffer.get_mut().expect("sole owner");
                buf.set_pts(gst::ClockTime::from_mseconds(processed.pts_ms));
            }
            if appsrc.push_buffer(buffer).is_err() {
                failed = Some("the encoder rejected a frame".into());
                return false;
            }
            true
        })?;

        let _ = appsrc.end_of_stream();
        if let Some(bus) = pipeline.bus() {
            for msg in bus.iter_timed(gst::ClockTime::from_seconds(30)) {
                match msg.view() {
                    gst::MessageView::Eos(_) => break,
                    gst::MessageView::Error(e) => {
                        failed = Some(e.error().to_string());
                        break;
                    }
                    _ => {}
                }
            }
        }
        let _ = pipeline.set_state(gst::State::Null);
        match failed {
            Some(message) => Err(RecordError::Backend(message)),
            None => Ok(()),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn poster(&self, _src: &Path, _dst: &Path) -> RecordResult<()> {
        Err(RecordError::Unsupported("not Linux".into()))
    }

    #[cfg(target_os = "linux")]
    fn poster(&self, src: &Path, dst: &Path) -> RecordResult<()> {
        let info = self.probe(src)?;
        // A third of the way in, like the macOS generator: the opening frames
        // of a screen recording are often still showing the overlay coming
        // down.
        let at = info.duration_ms / 3;
        let mut saved = false;
        self.decode_frames(
            src,
            TimeRange {
                start_ms: at,
                end_ms: at + 200,
            },
            0,
            &mut |frame| {
                saved = frame.image.save(dst).is_ok();
                false
            },
        )?;
        if !saved {
            return Err(RecordError::Backend(
                "couldn't make a thumbnail for that recording".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn uri_for(path: &Path) -> RecordResult<String> {
    let absolute = path
        .canonicalize()
        .map_err(|e| RecordError::Backend(e.to_string()))?;
    // Percent-encoded: the URI is spliced into a launch description, where a
    // raw space would end it.
    gst::glib::filename_to_uri(&absolute, None)
        .map(|uri| uri.to_string())
        .map_err(|e| RecordError::Backend(e.to_string()))
}

/// The pipeline a recording runs, as a `gst_parse_launch` description.
///
/// Kept `cfg`-free and pure so the encoder-selection logic -- the part most
/// likely to be wrong on a machine with an unusual plugin set -- is testable
/// from any platform, not just from a Linux box with GStreamer installed.
pub fn pipeline_description(
    w: u32,
    h: u32,
    fps: u32,
    input: &str,
    out: &str,
    encoders_available: &[&str],
) -> Option<String> {
    // Best first: ENCODERS is in order of preference.
    let encoder = ENCODERS
        .iter()
        .find(|e| encoders_available.contains(&e.name))?;

    // The queues put conversion and encoding on threads of their own, and
    // videoconvert splits each frame across cores -- serially on one thread a
    // 4K frame's conversion plus encode took longer than a frame lasts. The
    // appsrc holds at most a few frames and blocks when full, so an encoder
    // that still falls behind slows the capture loop (which then skips
    // slots) instead of queueing frames without bound.
    let max_bytes = 3 * w as u64 * h as u64 * 4;
    Some(format!(
        "appsrc name=src is-live=true format=time block=true max-bytes={max_bytes} \
         caps=video/x-raw,format={input},width={w},height={h},framerate={fps}/1 \
         ! queue ! videoconvert n-threads=0 ! video/x-raw,format={} ! queue ! {} \
         ! h264parse ! mp4mux ! filesink location={}",
        encoder.format,
        encoder.launch,
        parse_quoted(out)
    ))
}

/// A property value as `gst_parse_launch` reads it, double-quoted with its own
/// quotes and backslashes escaped. Bare, a path with a space in it -- the
/// default "SlickShot 2026-09-27 at 12.00.00.mp4" -- ends the value at the
/// space, and the parser takes the date for the name of the next element.
fn parse_quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_hardware_encoding_when_available() {
        let desc = pipeline_description(1920, 1080, 30, "RGBA", "/tmp/a.mp4", &["x264enc", "vaapih264enc"])
            .expect("a pipeline");
        assert!(desc.contains("format=NV12 ! queue ! vaapih264enc"), "got {desc}");
        assert!(!desc.contains("x264enc"), "hardware wins outright");
    }

    #[test]
    fn prefers_the_current_va_plugin_over_the_old_one() {
        let desc =
            pipeline_description(1920, 1080, 30, "RGBA", "/tmp/a.mp4", &["vaapih264enc", "vah264enc"])
                .expect("a pipeline");
        assert!(desc.contains("format=NV12 ! queue ! vah264enc"), "got {desc}");
    }

    #[test]
    fn falls_back_through_the_software_encoders() {
        let desc =
            pipeline_description(800, 600, 30, "RGBA", "/tmp/a.mp4", &["openh264enc"]).expect("a pipeline");
        assert!(desc.contains("openh264enc"), "got {desc}");
    }

    #[test]
    fn no_encoder_means_no_pipeline() {
        assert!(pipeline_description(800, 600, 30, "RGBA", "/tmp/a.mp4", &[]).is_none());
    }

    #[test]
    fn carries_the_capture_geometry_and_output() {
        let desc = pipeline_description(1280, 720, 60, "RGBA", "/tmp/out.mp4", &["x264enc"]).unwrap();
        assert!(desc.contains("width=1280,height=720"), "got {desc}");
        assert!(desc.contains("block=true max-bytes=11059200"), "got {desc}");
        assert!(desc.contains("framerate=60/1"), "got {desc}");
        assert!(desc.contains("location=\"/tmp/out.mp4\""), "got {desc}");
    }

    #[test]
    fn quotes_an_output_path_with_spaces() {
        let out = "/home/me/Videos/SlickShot 2026-09-27 at 23.20.mp4";
        let desc = pipeline_description(640, 480, 30, "RGBA", out, &["x264enc"]).unwrap();
        assert!(desc.ends_with(&format!("location=\"{out}\"")), "got {desc}");
        assert_eq!(parse_quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn encodes_4_2_0_chroma() {
        let desc = pipeline_description(1280, 720, 30, "RGBA", "/tmp/out.mp4", &["x264enc"]).unwrap();
        assert!(desc.contains("format=I420 ! queue ! x264enc"), "got {desc}");
    }

    #[test]
    fn the_encoder_list_and_the_pipeline_agree() {
        // `available_encoders` filters ENCODERS, and `pipeline_description`
        // matches on the same names -- a rename in one that missed the other
        // would silently mean "no encoder found" on every machine.
        for encoder in &ENCODERS {
            let desc = pipeline_description(64, 64, 30, "RGBA", "/tmp/a.mp4", &[encoder.name])
                .unwrap_or_else(|| panic!("{} is looked for but has no pipeline", encoder.name));
            assert!(
                matches!(encoder.format, "I420" | "NV12"),
                "{} must be fed 4:2:0",
                encoder.name
            );
            assert!(desc.contains(encoder.launch), "got {desc}");
        }
    }
}
