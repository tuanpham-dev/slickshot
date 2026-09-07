//! Screen recording: the platform backend abstraction and the pixel work
//! shared by all three of them.
//!
//! Each platform implements only the four things that genuinely need a native
//! media stack -- start a recording, probe a file, decode frames, re-encode
//! frames -- against `VideoBackend`. Everything the editor does to those
//! pixels (crop, resize, speed, annotation compositing, censor, GIF) lives in
//! `transform`/`gif` as ordinary Rust, so it is written and tested once
//! instead of three times.

// The decode/transcode half of `VideoBackend`, and the types it takes, are
// defined ahead of the editor export path that calls them (plan T3.1-T3.2).
#![allow(dead_code)]

pub mod gif;
pub mod pill;
pub mod transform;

use std::path::{Path, PathBuf};
use std::time::Duration;

use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::geometry::PhysRect;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// What a recording should capture. `rect` is physical pixels in the global
/// virtual-screen space, like every other rect crossing this app's IPC; the
/// platform module converts to whatever units its own API wants.
#[derive(Debug, Clone)]
pub struct RecordConfig {
    pub rect: PhysRect,
    pub monitor_id: u32,
    pub fps: u32,
    pub show_cursor: bool,
    pub system_audio: bool,
    pub microphone: bool,
    pub out_path: PathBuf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub fps: f32,
    pub has_audio: bool,
    /// How many separate audio tracks the file holds: 1 for system audio or
    /// microphone alone, 2 when both were recorded. Kept distinct from
    /// `has_audio` so a silent-microphone bug is visible as a missing track
    /// rather than hiding behind "yes, there is sound".
    #[serde(default)]
    pub audio_tracks: u32,
}

/// Where one audio track starts and ends, for diagnosing drift between two
/// tracks recorded from different clocks.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TrackOffsets {
    pub index: u32,
    pub first_pts_ms: f64,
    pub last_pts_ms: f64,
    pub samples: u64,
}

/// A half-open span of a clip, in milliseconds from its start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_ms: u64,
    pub end_ms: u64,
}

impl TimeRange {
    pub fn duration_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

/// One decoded frame, RGBA8, with its presentation time relative to the clip.
#[derive(Debug, Clone)]
pub struct RgbaFrame {
    pub image: RgbaImage,
    pub pts_ms: u64,
}

#[derive(Debug, Clone)]
pub struct TranscodeOptions {
    pub range: TimeRange,
    /// Playback multiplier: 2.0 makes the output half as long.
    pub speed: f32,
    /// Region of the *source* frame to keep, before resizing.
    pub crop: Option<PhysRect>,
    /// Final pixel size after crop.
    pub output: (u32, u32),
    pub keep_audio: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Permission(String),
    #[error("recording backend error: {0}")]
    Backend(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub type RecordResult<T> = Result<T, RecordError>;

/// A recording in flight. Stopping consumes it and yields the finished file;
/// cancelling consumes it and deletes it.
pub trait ActiveRecording: Send {
    fn stop(self: Box<Self>) -> RecordResult<PathBuf>;
    fn cancel(self: Box<Self>);
    fn elapsed(&self) -> Duration;
    /// Non-fatal problems worth telling the user about -- a denied microphone
    /// is the one that matters, since the recording otherwise looks fine
    /// right up until it plays back silent.
    fn warnings(&self) -> Vec<String> {
        Vec::new()
    }
}

pub trait VideoBackend: Send + Sync {
    fn start_recording(&self, cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>>;
    fn probe(&self, path: &Path) -> RecordResult<VideoInfo>;
    /// Decodes `range` at approximately `fps`, handing each frame to
    /// `on_frame`. Returning `false` from the callback stops the decode.
    fn decode_frames(
        &self,
        path: &Path,
        range: TimeRange,
        fps: u32,
        on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()>;
    /// Re-encodes `src` into `dst`. Each decoded frame goes through
    /// `process`, which returns the frame to write (with its output PTS
    /// already set) or `None` to drop it -- that is how speed, crop,
    /// compositing and censoring reach the output without any of them
    /// living in a platform module.
    fn transcode(
        &self,
        src: &Path,
        dst: &Path,
        opts: &TranscodeOptions,
        process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()>;
    /// Writes a poster frame from mid-clip as a PNG, for history cards.
    fn poster(&self, src: &Path, dst: &Path) -> RecordResult<()>;

    /// Per-audio-track timing, for `slickshot probe --track-offsets`. A
    /// diagnostic rather than something the app depends on, so a backend that
    /// has not implemented it stays usable.
    fn track_offsets(&self, _path: &Path) -> RecordResult<Vec<TrackOffsets>> {
        Err(RecordError::Unsupported(
            "track offsets aren't available on this platform".into(),
        ))
    }
}

pub fn default_backend() -> Box<dyn VideoBackend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacBackend)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsBackend)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(linux::LinuxBackend)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Box::new(UnsupportedBackend)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
struct UnsupportedBackend;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
impl VideoBackend for UnsupportedBackend {
    fn start_recording(&self, _: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        Err(RecordError::Unsupported(
            "screen recording isn't supported on this platform".into(),
        ))
    }
    fn probe(&self, _: &Path) -> RecordResult<VideoInfo> {
        Err(RecordError::Unsupported(
            "screen recording isn't supported on this platform".into(),
        ))
    }
    fn decode_frames(
        &self,
        _: &Path,
        _: TimeRange,
        _: u32,
        _: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        Err(RecordError::Unsupported(
            "screen recording isn't supported on this platform".into(),
        ))
    }
    fn transcode(
        &self,
        _: &Path,
        _: &Path,
        _: &TranscodeOptions,
        _: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        Err(RecordError::Unsupported(
            "screen recording isn't supported on this platform".into(),
        ))
    }
    fn poster(&self, _: &Path, _: &Path) -> RecordResult<()> {
        Err(RecordError::Unsupported(
            "screen recording isn't supported on this platform".into(),
        ))
    }
}
