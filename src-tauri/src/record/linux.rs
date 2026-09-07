//! Linux recording backend: `xcap` frames pushed through a GStreamer
//! pipeline. Not yet implemented -- see the plan's T5.2.

use std::path::Path;

use super::{
    ActiveRecording, RecordConfig, RecordError, RecordResult, RgbaFrame, TimeRange,
    TranscodeOptions, VideoBackend, VideoInfo,
};

pub struct LinuxBackend;

fn pending<T>() -> RecordResult<T> {
    Err(RecordError::Unsupported(
        "screen recording isn't available on Linux in this build yet".into(),
    ))
}

impl VideoBackend for LinuxBackend {
    fn start_recording(&self, _cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        pending()
    }
    fn probe(&self, _path: &Path) -> RecordResult<VideoInfo> {
        pending()
    }
    fn decode_frames(
        &self,
        _path: &Path,
        _range: TimeRange,
        _fps: u32,
        _on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        pending()
    }
    fn transcode(
        &self,
        _src: &Path,
        _dst: &Path,
        _opts: &TranscodeOptions,
        _process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        pending()
    }
    fn poster(&self, _src: &Path, _dst: &Path) -> RecordResult<()> {
        pending()
    }
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
}
