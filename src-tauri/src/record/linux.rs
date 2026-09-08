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
#[cfg(target_os = "linux")]
use super::transform::{self, FramePacer};

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

/// The H.264 encoders this looks for, best first.
const ENCODERS: [&str; 3] = ["vaapih264enc", "x264enc", "openh264enc"];

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
            reason: "No H.264 encoder found. Install gstreamer1.0-plugins-ugly (x264) or \
                     gstreamer1.0-vaapi for hardware encoding."
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

#[cfg(target_os = "linux")]
fn available_encoders() -> Vec<&'static str> {
    let registry = gst::Registry::get();
    ENCODERS
        .iter()
        .filter(|name| registry.find_feature(name, gst::ElementFactory::static_type()).is_some())
        .copied()
        .collect()
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

        let monitors = xcap::Monitor::all().map_err(|e| RecordError::Backend(e.to_string()))?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.id().map(|id| id == cfg.monitor_id).unwrap_or(false))
            .ok_or_else(|| RecordError::Backend("that monitor is gone".into()))?;

        let running = Arc::new(AtomicBool::new(true));
        let started = Instant::now();

        // Where in the monitor the region sits. `rect` is global physical
        // pixels, the monitor's own origin is too, so this is a subtraction --
        // no scale factor involved, unlike the macOS path.
        let origin_x = cfg.rect.x - monitor.x().unwrap_or(0);
        let origin_y = cfg.rect.y - monitor.y().unwrap_or(0);
        let crop = crate::geometry::PhysRect::new(origin_x, origin_y, w, h);

        let src = appsrc.clone();
        let flag = running.clone();
        let fps = cfg.fps;
        let capture = std::thread::spawn(move || {
            let Ok((recorder, frames)) = monitor.video_recorder() else {
                return;
            };
            if recorder.start().is_err() {
                return;
            }
            let mut pacer = FramePacer::new(fps);
            for frame in frames {
                if !flag.load(Ordering::SeqCst) {
                    break;
                }
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                if !pacer.accept(elapsed_ms) {
                    continue;
                }
                let Some(image) =
                    RgbaImage::from_raw(frame.width, frame.height, frame.raw.clone())
                else {
                    continue;
                };
                let cropped = transform::crop(&image, crop);
                if cropped.dimensions() != (w, h) {
                    continue;
                }

                let mut buffer = gst::Buffer::from_mut_slice(cropped.into_raw());
                {
                    let buf = buffer.get_mut().expect("sole owner");
                    buf.set_pts(gst::ClockTime::from_mseconds(elapsed_ms as u64));
                }
                if src.push_buffer(buffer).is_err() {
                    break;
                }
            }
            let _ = recorder.stop();
        });

        Ok(Box::new(LinuxRecording {
            pipeline,
            appsrc,
            running,
            started,
            out_path: cfg.out_path.clone(),
            capture: Some(capture),
            // Neither audio nor the cursor is drawn by xcap's Linux recorder.
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
        use gstreamer_pbutils::prelude::*;
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
        let speed = opts.speed.max(0.01) as f64;
        let mut failed: Option<String> = None;
        self.decode_frames(src, opts.range, 0, &mut |frame| {
            let out_pts = ((frame.pts_ms.saturating_sub(start)) as f64 / speed) as u64;
            let Some(processed) = process(RgbaFrame {
                image: frame.image,
                pts_ms: out_pts,
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
    Ok(format!("file://{}", absolute.to_string_lossy()))
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
    out: &str,
    encoders_available: &[&str],
) -> Option<String> {
    // Hardware first, then the two software encoders in the order they are
    // usually preferred; x264enc is tuned for low latency because this is a
    // live capture, not a file conversion.
    const CANDIDATES: [(&str, &str); 3] = [
        ("vaapih264enc", "vaapih264enc"),
        ("x264enc", "x264enc speed-preset=veryfast tune=zerolatency"),
        ("openh264enc", "openh264enc"),
    ];
    let encoder = CANDIDATES
        .iter()
        .find(|(name, _)| encoders_available.contains(name))
        .map(|(_, launch)| *launch)?;

    Some(format!(
        "appsrc name=src is-live=true format=time \
         caps=video/x-raw,format=RGBA,width={w},height={h},framerate={fps}/1 \
         ! videoconvert ! {encoder} ! h264parse ! mp4mux ! filesink location={out}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_hardware_encoding_when_available() {
        let desc = pipeline_description(1920, 1080, 30, "/tmp/a.mp4", &["x264enc", "vaapih264enc"])
            .expect("a pipeline");
        assert!(desc.contains("vaapih264enc"), "got {desc}");
        assert!(!desc.contains("x264enc"), "hardware wins outright");
    }

    #[test]
    fn falls_back_through_the_software_encoders() {
        let desc =
            pipeline_description(800, 600, 30, "/tmp/a.mp4", &["openh264enc"]).expect("a pipeline");
        assert!(desc.contains("openh264enc"), "got {desc}");
    }

    #[test]
    fn no_encoder_means_no_pipeline() {
        assert!(pipeline_description(800, 600, 30, "/tmp/a.mp4", &[]).is_none());
    }

    #[test]
    fn carries_the_capture_geometry_and_output() {
        let desc = pipeline_description(1280, 720, 60, "/tmp/out.mp4", &["x264enc"]).unwrap();
        assert!(desc.contains("width=1280,height=720"), "got {desc}");
        assert!(desc.contains("framerate=60/1"), "got {desc}");
        assert!(desc.contains("location=/tmp/out.mp4"), "got {desc}");
    }

    #[test]
    fn the_encoder_list_and_the_pipeline_agree() {
        // `available_encoders` filters ENCODERS, and `pipeline_description`
        // matches on the same names -- a rename in one that missed the other
        // would silently mean "no encoder found" on every machine.
        for name in ENCODERS {
            assert!(
                pipeline_description(64, 64, 30, "/tmp/a.mp4", &[name]).is_some(),
                "{name} is looked for but has no pipeline"
            );
        }
    }
}
