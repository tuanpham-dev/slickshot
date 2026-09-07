//! Windows recording backend: `xcap` frames into a Media Foundation sink
//! writer. Not yet implemented -- see the plan's T5.1.

use std::path::Path;

use super::{
    ActiveRecording, RecordConfig, RecordError, RecordResult, RgbaFrame, TimeRange,
    TranscodeOptions, VideoBackend, VideoInfo,
};

pub struct WindowsBackend;

fn pending<T>() -> RecordResult<T> {
    Err(RecordError::Unsupported(
        "screen recording isn't available on Windows in this build yet".into(),
    ))
}

impl VideoBackend for WindowsBackend {
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
