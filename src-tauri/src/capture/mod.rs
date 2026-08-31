pub mod input;
pub mod stitch;
mod xcap_backend;

use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::geometry::PhysRect;

pub use xcap_backend::XcapCapturer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub rect: PhysRect,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub rect: PhysRect,
}

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("no monitor with id {0}")]
    MonitorNotFound(u32),
    #[error("no window with id {0}")]
    #[allow(dead_code)] // kept for ScreenCapturer trait completeness; window mode composites from monitor frames instead
    WindowNotFound(u32),
    #[error("captured image size {got_w}x{got_h} does not match expected geometry {expected_w}x{expected_h}")]
    SizeMismatch {
        got_w: u32,
        got_h: u32,
        expected_w: u32,
        expected_h: u32,
    },
    #[error("platform capture backend error: {0}")]
    Backend(String),
}

pub type CaptureResult<T> = Result<T, CaptureError>;

/// Abstraction over a platform screen-capture backend. All rects are physical
/// pixels in the global virtual-screen coordinate space -- see the plan's
/// "Approach" section for why this is the only unambiguous coordinate space
/// on X11 with mixed per-monitor scaling.
pub trait ScreenCapturer: Send + Sync {
    fn monitors(&self) -> CaptureResult<Vec<MonitorInfo>>;
    fn capture_monitor(&self, id: u32) -> CaptureResult<RgbaImage>;
    fn windows(&self) -> CaptureResult<Vec<WindowInfo>>;
    /// Kept for trait completeness / a future fast-path; the app currently
    /// composites window-mode captures from the frozen monitor frames
    /// instead (see `selection::selection_confirm_rect`).
    #[allow(dead_code)]
    fn capture_window(&self, id: u32) -> CaptureResult<RgbaImage>;
}

pub fn default_capturer() -> Box<dyn ScreenCapturer> {
    Box::new(XcapCapturer::new())
}
