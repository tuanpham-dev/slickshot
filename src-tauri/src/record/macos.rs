//! macOS recording backend. All the Objective-C lives in `screen_record.m`;
//! this is the marshalling layer, shaped like `ocr.rs`'s Vision bindings.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use image::RgbaImage;

use super::{
    ActiveRecording, RecordConfig, RecordError, RecordResult, RgbaFrame, TimeRange, TrackOffsets,
    TranscodeOptions, VideoBackend, VideoInfo,
};

const FLAG_MIC_DENIED: i32 = 1 << 0;
const FLAG_MIC_FAILED: i32 = 1 << 1;

extern "C" {
    fn tas_record_start(
        display_id: u32,
        x_pt: f64,
        y_pt: f64,
        w_pt: f64,
        h_pt: f64,
        scale: f64,
        fps: u32,
        cursor: bool,
        system_audio: bool,
        microphone: bool,
        out_path: *const c_char,
        err_out: *mut *mut c_char,
    ) -> *mut c_void;
    fn tas_record_stop(session: *mut c_void, err_out: *mut *mut c_char) -> *mut c_char;
    fn tas_record_cancel(session: *mut c_void);
    fn tas_record_flags(session: *mut c_void) -> i32;
    fn tas_video_probe(path: *const c_char, err_out: *mut *mut c_char) -> *mut c_char;
    fn tas_video_track_offsets(path: *const c_char, err_out: *mut *mut c_char) -> *mut c_char;
    fn tas_video_poster(
        src: *const c_char,
        dst: *const c_char,
        err_out: *mut *mut c_char,
    ) -> bool;
    fn tas_video_decode(
        path: *const c_char,
        start_s: f64,
        end_s: f64,
        fps: u32,
        ctx: *mut c_void,
        on_frame: extern "C" fn(*mut c_void, *const u8, u32, u32, u32, f64) -> bool,
        err_out: *mut *mut c_char,
    ) -> i32;
    #[allow(clippy::too_many_arguments)]
    fn tas_video_transcode(
        src: *const c_char,
        dst: *const c_char,
        start_s: f64,
        end_s: f64,
        speed: f64,
        out_w: u32,
        out_h: u32,
        keep_audio: bool,
        ctx: *mut c_void,
        process: extern "C" fn(*mut c_void, *const u8, u32, u32, u32, *mut u8, *mut f64) -> bool,
        err_out: *mut *mut c_char,
    ) -> i32;
    fn tas_record_free(p: *mut c_char);
}

/// Takes ownership of a shim error string, if there is one.
unsafe fn take_err(err: *mut c_char) -> Option<String> {
    if err.is_null() {
        return None;
    }
    let s = CStr::from_ptr(err).to_string_lossy().into_owned();
    tas_record_free(err);
    Some(s)
}

unsafe fn take_string(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    tas_record_free(ptr);
    Some(s)
}

fn c_path(path: &Path) -> RecordResult<CString> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| RecordError::Backend("that path contains a NUL byte".into()))
}

/// The opaque ObjC session, plus what Rust needs to answer `elapsed` without
/// crossing the FFI on a timer tick.
struct MacRecording {
    session: *mut c_void,
    started: Instant,
    warnings: Vec<String>,
}

// The ObjC side serializes every touch of the session onto its own dispatch
// queue, and the pointer is only ever used from the recording thread that
// owns this value.
unsafe impl Send for MacRecording {}

impl ActiveRecording for MacRecording {
    fn stop(self: Box<Self>) -> RecordResult<PathBuf> {
        let mut err: *mut c_char = std::ptr::null_mut();
        let out = unsafe { tas_record_stop(self.session, &mut err) };
        if let Some(message) = unsafe { take_err(err) } {
            return Err(RecordError::Backend(message));
        }
        let path = unsafe { take_string(out) }
            .ok_or_else(|| RecordError::Backend("the recording produced no file".into()))?;
        Ok(PathBuf::from(path))
    }

    fn cancel(self: Box<Self>) {
        unsafe { tas_record_cancel(self.session) };
    }

    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }
}

pub struct MacBackend;

impl MacBackend {
    /// Converts a physical-pixel rect in the global virtual-screen space into
    /// the display-local points ScreenCaptureKit's `sourceRect` wants, plus
    /// the scale factor the output pixel size is derived from.
    ///
    /// Everything crossing this app's IPC is physical pixels (see
    /// `capture/xcap_backend.rs`), and Core Graphics is entirely in points --
    /// the same mismatch that made scrolling capture warp the pointer to
    /// twice the intended spot before it was fixed.
    fn to_points(cfg: &RecordConfig) -> RecordResult<(f64, f64, f64, f64, f64, u32)> {
        let monitors = xcap::Monitor::all()
            .map_err(|e| RecordError::Backend(format!("couldn't list monitors: {e}")))?;
        let monitor = monitors
            .iter()
            .find(|m| m.id().map(|id| id == cfg.monitor_id).unwrap_or(false))
            .ok_or_else(|| {
                RecordError::Backend("the monitor being recorded is no longer attached".into())
            })?;

        let scale = monitor.scale_factor().unwrap_or(1.0) as f64;
        let origin_x = monitor.x().unwrap_or(0) as f64;
        let origin_y = monitor.y().unwrap_or(0) as f64;

        // `rect` is physical and global; `sourceRect` is points and relative
        // to the display's own top-left.
        let x_pt = cfg.rect.x as f64 / scale - origin_x;
        let y_pt = cfg.rect.y as f64 / scale - origin_y;
        let w_pt = cfg.rect.w as f64 / scale;
        let h_pt = cfg.rect.h as f64 / scale;

        let display_id = monitor
            .id()
            .map_err(|e| RecordError::Backend(format!("couldn't read the monitor id: {e}")))?;

        Ok((x_pt, y_pt, w_pt, h_pt, scale, display_id))
    }
}

impl VideoBackend for MacBackend {
    fn start_recording(&self, cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        let (x_pt, y_pt, w_pt, h_pt, scale, display_id) = Self::to_points(cfg)?;

        if let Some(parent) = cfg.out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let out = c_path(&cfg.out_path)?;

        let mut err: *mut c_char = std::ptr::null_mut();
        let session = unsafe {
            tas_record_start(
                display_id,
                x_pt,
                y_pt,
                w_pt,
                h_pt,
                scale,
                cfg.fps,
                cfg.show_cursor,
                cfg.system_audio,
                cfg.microphone,
                out.as_ptr(),
                &mut err,
            )
        };
        if let Some(message) = unsafe { take_err(err) } {
            // Screen Recording denial reads as a plain backend failure from
            // the shim, but it is the one the user can actually act on.
            if message.contains("Screen Recording") {
                return Err(RecordError::Permission(message));
            }
            return Err(RecordError::Backend(message));
        }
        if session.is_null() {
            return Err(RecordError::Backend(
                "the recording didn't start, and macOS gave no reason".into(),
            ));
        }

        let flags = unsafe { tas_record_flags(session) };
        let mut warnings = Vec::new();
        if flags & FLAG_MIC_DENIED != 0 {
            warnings.push(
                "Microphone access denied -- recording without it. Turn it on in System Settings > \
                 Privacy & Security > Microphone."
                    .into(),
            );
        }
        if flags & FLAG_MIC_FAILED != 0 {
            warnings.push("No microphone was available -- recording without it.".into());
        }

        Ok(Box::new(MacRecording {
            session,
            started: Instant::now(),
            warnings,
        }))
    }

    fn probe(&self, path: &Path) -> RecordResult<VideoInfo> {
        let c = c_path(path)?;
        let mut err: *mut c_char = std::ptr::null_mut();
        let out = unsafe { tas_video_probe(c.as_ptr(), &mut err) };
        if let Some(message) = unsafe { take_err(err) } {
            return Err(RecordError::Backend(message));
        }
        let row = unsafe { take_string(out) }
            .ok_or_else(|| RecordError::Backend("couldn't read that movie".into()))?;
        parse_probe(&row)
    }

    fn decode_frames(
        &self,
        path: &Path,
        range: TimeRange,
        fps: u32,
        on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        let c = c_path(path)?;
        let mut state = DecodeCtx {
            on_frame,
            panicked: false,
        };
        let mut err: *mut c_char = std::ptr::null_mut();
        let rc = unsafe {
            tas_video_decode(
                c.as_ptr(),
                range.start_ms as f64 / 1000.0,
                range.end_ms as f64 / 1000.0,
                fps,
                &mut state as *mut DecodeCtx as *mut c_void,
                decode_trampoline,
                &mut err,
            )
        };
        if let Some(message) = unsafe { take_err(err) } {
            return Err(RecordError::Backend(message));
        }
        if state.panicked {
            return Err(RecordError::Backend(
                "decoding a frame failed unexpectedly".into(),
            ));
        }
        if rc != 0 {
            return Err(RecordError::Backend("couldn't decode that recording".into()));
        }
        Ok(())
    }

    fn transcode(
        &self,
        src: &Path,
        dst: &Path,
        opts: &TranscodeOptions,
        process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        let (s, d) = (c_path(src)?, c_path(dst)?);
        let (out_w, out_h) = opts.output;
        if out_w < 2 || out_h < 2 {
            return Err(RecordError::Backend(
                "that export size is too small".into(),
            ));
        }
        let mut state = TranscodeCtx {
            process,
            out_w,
            out_h,
            panicked: false,
        };
        let mut err: *mut c_char = std::ptr::null_mut();
        let rc = unsafe {
            tas_video_transcode(
                s.as_ptr(),
                d.as_ptr(),
                opts.range.start_ms as f64 / 1000.0,
                opts.range.end_ms as f64 / 1000.0,
                opts.speed as f64,
                out_w,
                out_h,
                opts.keep_audio,
                &mut state as *mut TranscodeCtx as *mut c_void,
                transcode_trampoline,
                &mut err,
            )
        };
        if let Some(message) = unsafe { take_err(err) } {
            return Err(RecordError::Backend(message));
        }
        if state.panicked {
            return Err(RecordError::Backend(
                "processing a frame failed unexpectedly".into(),
            ));
        }
        if rc != 0 {
            return Err(RecordError::Backend("couldn't export that recording".into()));
        }
        Ok(())
    }

    fn track_offsets(&self, path: &Path) -> RecordResult<Vec<TrackOffsets>> {
        let c = c_path(path)?;
        let mut err: *mut c_char = std::ptr::null_mut();
        let out = unsafe { tas_video_track_offsets(c.as_ptr(), &mut err) };
        if let Some(message) = unsafe { take_err(err) } {
            return Err(RecordError::Backend(message));
        }
        let text = unsafe { take_string(out) }
            .ok_or_else(|| RecordError::Backend("couldn't read that movie".into()))?;
        parse_track_offsets(&text)
    }

    fn poster(&self, src: &Path, dst: &Path) -> RecordResult<()> {
        let (s, d) = (c_path(src)?, c_path(dst)?);
        let mut err: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { tas_video_poster(s.as_ptr(), d.as_ptr(), &mut err) };
        if let Some(message) = unsafe { take_err(err) } {
            return Err(RecordError::Backend(message));
        }
        if !ok {
            return Err(RecordError::Backend(
                "couldn't make a thumbnail for that recording".into(),
            ));
        }
        Ok(())
    }
}

/// Parses the shim's tab-separated probe row. Split out so the parsing is
/// testable without a movie file.
fn parse_probe(row: &str) -> RecordResult<VideoInfo> {
    let cols: Vec<&str> = row.split('\t').collect();
    if cols.len() < 5 {
        return Err(RecordError::Backend(format!(
            "couldn't understand this movie's details: {row:?}"
        )));
    }
    let num = |i: usize| -> RecordResult<f64> {
        cols[i]
            .parse::<f64>()
            .map_err(|_| RecordError::Backend(format!("couldn't understand {:?}", cols[i])))
    };
    Ok(VideoInfo {
        width: num(0)? as u32,
        height: num(1)? as u32,
        duration_ms: num(2)?.max(0.0) as u64,
        fps: num(3)? as f32,
        has_audio: cols[4] == "1",
        // Older shim rows stopped at `has_audio`; fall back to what that
        // implies rather than refusing to parse.
        audio_tracks: match cols.get(5) {
            Some(n) => n.parse::<u32>().unwrap_or(0),
            None => u32::from(cols[4] == "1"),
        },
    })
}

/// One row per track: `index\tfirst_pts_ms\tlast_pts_ms\tsamples`.
fn parse_track_offsets(text: &str) -> RecordResult<Vec<TrackOffsets>> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 4 {
                return Err(RecordError::Backend(format!(
                    "couldn't understand this track's timing: {line:?}"
                )));
            }
            let bad = |c: &str| RecordError::Backend(format!("couldn't understand {c:?}"));
            Ok(TrackOffsets {
                index: cols[0].parse().map_err(|_| bad(cols[0]))?,
                first_pts_ms: cols[1].parse().map_err(|_| bad(cols[1]))?,
                last_pts_ms: cols[2].parse().map_err(|_| bad(cols[2]))?,
                samples: cols[3].parse().map_err(|_| bad(cols[3]))?,
            })
        })
        .collect()
}

/// Unused today; kept so the frame-conversion helper the decode path will
/// need has one home rather than being written twice.
#[allow(dead_code)]
pub(crate) fn bgra_to_rgba(bgra: &[u8], width: u32, height: u32, stride: usize) -> Option<RgbaImage> {
    let mut out = RgbaImage::new(width, height);
    for y in 0..height as usize {
        let row = &bgra.get(y * stride..y * stride + width as usize * 4)?;
        for x in 0..width as usize {
            let p = &row[x * 4..x * 4 + 4];
            out.put_pixel(
                x as u32,
                y as u32,
                image::Rgba([p[2], p[1], p[0], p[3]]),
            );
        }
    }
    Some(out)
}

// -- Callback plumbing ------------------------------------------------------
//
// The shim calls back per frame through a plain C function pointer, so the
// Rust closure travels as an opaque `ctx`. Both trampolines catch panics:
// unwinding out of these and into Objective-C is undefined behaviour, so a
// panic is recorded and reported as an error once control is back in Rust.

struct DecodeCtx<'a, 'b> {
    on_frame: &'a mut (dyn FnMut(RgbaFrame) -> bool + 'b),
    panicked: bool,
}

struct TranscodeCtx<'a, 'b> {
    process: &'a mut (dyn FnMut(RgbaFrame) -> Option<RgbaFrame> + 'b),
    out_w: u32,
    out_h: u32,
    panicked: bool,
}

extern "C" fn decode_trampoline(
    ctx: *mut c_void,
    bgra: *const u8,
    w: u32,
    h: u32,
    stride: u32,
    pts_s: f64,
) -> bool {
    let state = unsafe { &mut *(ctx as *mut DecodeCtx) };
    if state.panicked {
        return false;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let bytes =
            unsafe { std::slice::from_raw_parts(bgra, stride as usize * h as usize) };
        let Some(image) = bgra_to_rgba(bytes, w, h, stride as usize) else {
            return false;
        };
        (state.on_frame)(RgbaFrame {
            image,
            pts_ms: (pts_s * 1000.0).max(0.0) as u64,
        })
    }));
    match result {
        Ok(keep_going) => keep_going,
        Err(_) => {
            state.panicked = true;
            false
        }
    }
}

extern "C" fn transcode_trampoline(
    ctx: *mut c_void,
    bgra_in: *const u8,
    in_w: u32,
    in_h: u32,
    in_stride: u32,
    bgra_out: *mut u8,
    pts_s_inout: *mut f64,
) -> bool {
    let state = unsafe { &mut *(ctx as *mut TranscodeCtx) };
    if state.panicked {
        return false;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let bytes =
            unsafe { std::slice::from_raw_parts(bgra_in, in_stride as usize * in_h as usize) };
        let Some(image) = bgra_to_rgba(bytes, in_w, in_h, in_stride as usize) else {
            return false;
        };
        let pts_ms = unsafe { (*pts_s_inout * 1000.0).max(0.0) as u64 };
        let Some(frame) = (state.process)(RgbaFrame { image, pts_ms }) else {
            return false;
        };

        // The shim's buffer is exactly out_w x out_h and tightly packed; a
        // frame of any other size would write past it.
        if frame.image.dimensions() != (state.out_w, state.out_h) {
            return false;
        }
        let out = unsafe {
            std::slice::from_raw_parts_mut(bgra_out, state.out_w as usize * state.out_h as usize * 4)
        };
        for (dst, px) in out.as_chunks_mut::<4>().0.iter_mut().zip(frame.image.pixels()) {
            let [r, g, b, a] = px.0;
            dst.copy_from_slice(&[b, g, r, a]);
        }
        unsafe { *pts_s_inout = frame.pts_ms as f64 / 1000.0 };
        true
    }));
    match result {
        Ok(keep) => keep,
        Err(_) => {
            state.panicked = true;
            false
        }
    }
}

/// Frame counter used by the live tests to assert a decode produced frames.
#[allow(dead_code)]
static DECODED: AtomicU64 = AtomicU64::new(0);

#[allow(dead_code)]
pub(crate) fn note_decoded() {
    DECODED.fetch_add(1, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_probe_row() {
        let info = parse_probe("1600\t1000\t4200\t30.000\t1\t2").expect("parse");
        assert_eq!((info.width, info.height), (1600, 1000));
        assert_eq!(info.duration_ms, 4200);
        assert!((info.fps - 30.0).abs() < 0.01);
        assert!(info.has_audio);
    }

    #[test]
    fn probe_without_audio_reads_false() {
        let info = parse_probe("800\t600\t1000\t60.000\t0\t0").expect("parse");
        assert!(!info.has_audio);
    }

    #[test]
    fn a_short_probe_row_is_an_error() {
        assert!(parse_probe("800\t600").is_err());
    }

    #[test]
    fn probe_reports_the_track_count() {
        assert_eq!(
            parse_probe("1600\t1000\t4200\t30.000\t1\t2")
                .expect("parse")
                .audio_tracks,
            2
        );
        assert_eq!(
            parse_probe("1600\t1000\t4200\t30.000\t1\t1")
                .expect("parse")
                .audio_tracks,
            1
        );
    }

    #[test]
    fn a_probe_row_without_a_track_count_falls_back_to_has_audio() {
        let info = parse_probe("1600\t1000\t4200\t30.000\t1").expect("parse");
        assert_eq!(info.audio_tracks, 1, "audio, so at least one track");
        let silent = parse_probe("1600\t1000\t4200\t30.000\t0").expect("parse");
        assert_eq!(silent.audio_tracks, 0);
    }

    #[test]
    fn parses_track_offsets() {
        let tracks = parse_track_offsets("0\t0.000\t5000.500\t240\n1\t12.750\t5008.125\t235")
            .expect("parse");
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].index, 0);
        assert_eq!(tracks[0].samples, 240);
        assert!((tracks[1].first_pts_ms - 12.75).abs() < 1e-6);
        assert!((tracks[1].last_pts_ms - 5008.125).abs() < 1e-6);
    }

    #[test]
    fn no_audio_tracks_parses_as_empty() {
        assert!(parse_track_offsets("").expect("parse").is_empty());
    }

    #[test]
    fn a_short_track_row_is_an_error() {
        assert!(parse_track_offsets("0\t1.0").is_err());
    }

    #[test]
    fn bgra_converts_channel_order() {
        // One pixel, BGRA -> RGBA.
        let px = [10u8, 20, 30, 255];
        let img = bgra_to_rgba(&px, 1, 1, 4).expect("convert");
        assert_eq!(img.get_pixel(0, 0).0, [30, 20, 10, 255]);
    }
}

/// Live tests: these drive the real ScreenCaptureKit path and need Screen
/// Recording permission, so they are `#[ignore]`d and run with
/// `cargo test -- --ignored`.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::geometry::PhysRect;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    #[ignore]
    fn records_two_seconds() {
        let monitors = xcap::Monitor::all().expect("monitors");
        let primary = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .expect("a monitor");
        let scale = primary.scale_factor().unwrap_or(1.0) as f64;
        let id = primary.id().expect("id");

        // 400x300 points at the display's top-left, expressed physically.
        let rect = PhysRect::new(
            (primary.x().unwrap_or(0) as f64 * scale) as i32,
            (primary.y().unwrap_or(0) as f64 * scale) as i32,
            (400.0 * scale) as u32,
            (300.0 * scale) as u32,
        );
        let out = temp_path("slickshot-live-record.mp4");

        let backend = MacBackend;
        let recording = backend
            .start_recording(&RecordConfig {
                rect,
                monitor_id: id,
                fps: 30,
                show_cursor: true,
                system_audio: false,
                microphone: false,
                out_path: out.clone(),
            })
            .expect("start");

        std::thread::sleep(Duration::from_secs(2));
        let path = recording.stop().expect("stop");

        let info = backend.probe(&path).expect("probe");
        assert_eq!(
            (info.width, info.height),
            ((400.0 * scale) as u32, (300.0 * scale) as u32),
            "the file's pixel size must match the requested region"
        );
        assert!(
            (1_700..=2_400).contains(&info.duration_ms),
            "expected about 2s, got {}ms",
            info.duration_ms
        );
        assert!(!info.has_audio);
        let _ = std::fs::remove_file(&path);
    }

    /// A small region on the primary display, expressed physically -- the
    /// units every rect crossing this app's IPC uses.
    fn live_test_region() -> (PhysRect, u32) {
        let monitors = xcap::Monitor::all().expect("monitors");
        let primary = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .expect("a monitor");
        let scale = primary.scale_factor().unwrap_or(1.0) as f64;
        let rect = PhysRect::new(
            (primary.x().unwrap_or(0) as f64 * scale) as i32,
            (primary.y().unwrap_or(0) as f64 * scale) as i32,
            (400.0 * scale) as u32,
            (300.0 * scale) as u32,
        );
        (rect, primary.id().expect("id"))
    }

    /// Live: records a few seconds, then decodes and re-encodes a one-second
    /// slice of it -- the editor's export path end to end.
    #[test]
    #[ignore]
    fn decodes_and_transcodes_a_slice() {
        let (rect, monitor_id) = live_test_region();
        let src = temp_path("slickshot-live-transcode-src.mp4");
        let dst = temp_path("slickshot-live-transcode-out.mp4");
        let backend = MacBackend;

        let recording = backend
            .start_recording(&RecordConfig {
                rect,
                monitor_id,
                fps: 30,
                show_cursor: true,
                system_audio: true,
                microphone: false,
                out_path: src.clone(),
            })
            .expect("start");
        std::thread::sleep(Duration::from_secs(3));
        let src = recording.stop().expect("stop");

        let before = backend.probe(&src).expect("probe source");
        println!(
            "source: {}x{} {}ms audio={}",
            before.width, before.height, before.duration_ms, before.has_audio
        );

        // Decode 1.0s-2.0s at 10fps: about ten frames, give or take where the
        // source's own variable frame timing lands.
        let range = TimeRange {
            start_ms: 1_000,
            end_ms: 2_000,
        };
        let mut seen: Vec<u64> = Vec::new();
        backend
            .decode_frames(&src, range, 10, &mut |frame| {
                assert_eq!(
                    frame.image.dimensions(),
                    (before.width, before.height),
                    "decoded frames come back at the source's size"
                );
                seen.push(frame.pts_ms);
                true
            })
            .expect("decode");
        println!("decoded {} frames: {:?}", seen.len(), seen);
        assert!(
            (8..=12).contains(&seen.len()),
            "expected about ten frames at 10fps over one second, got {}",
            seen.len()
        );

        // And the callback really can stop the decode early.
        let mut count = 0;
        backend
            .decode_frames(&src, range, 10, &mut |_| {
                count += 1;
                count < 3
            })
            .expect("decode with early stop");
        assert_eq!(count, 3, "returning false stops the decode");

        // Identity transcode of the same range.
        let opts = TranscodeOptions {
            range,
            speed: 1.0,
            crop: None,
            output: (before.width, before.height),
            keep_audio: true,
        };
        let mut passed = 0;
        backend
            .transcode(&src, &dst, &opts, &mut |frame| {
                passed += 1;
                Some(frame)
            })
            .expect("transcode");
        println!("transcoded {passed} frames");

        let after = backend.probe(&dst).expect("probe output");
        println!(
            "output: {}x{} {}ms audio={} tracks={}",
            after.width, after.height, after.duration_ms, after.has_audio, after.audio_tracks
        );
        assert_eq!(
            (after.width, after.height),
            (before.width, before.height),
            "an identity transcode keeps the size"
        );
        assert!(
            (900..=1_100).contains(&after.duration_ms),
            "expected about 1000ms, got {}ms",
            after.duration_ms
        );
        assert_eq!(
            after.has_audio, before.has_audio,
            "keep_audio should carry the sound across"
        );

        // Speed: the video side is the callback's job (it halves each PTS),
        // the audio side is the shim's scaleTimeRange. Both have to land on
        // the same duration or the export drifts out of sync.
        let fast = TranscodeOptions {
            speed: 2.0,
            ..opts.clone()
        };
        backend
            .transcode(&src, &dst, &fast, &mut |mut frame| {
                frame.pts_ms /= 2;
                Some(frame)
            })
            .expect("transcode at 2x");
        let sped = backend.probe(&dst).expect("probe 2x output");
        println!("2x output: {}ms audio={}", sped.duration_ms, sped.has_audio);
        assert!(
            (400..=600).contains(&sped.duration_ms),
            "2x should halve a 1s slice, got {}ms",
            sped.duration_ms
        );
        assert!(sped.has_audio, "audio survives a speed change");

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    /// Live: the editor's whole export pipeline -- crop, resize, censor and a
    /// burnt-in overlay -- into both output formats.
    #[test]
    #[ignore]
    fn exports_a_processed_clip_as_mp4_and_gif() {
        use crate::record::transform::{self, Censor, CensorMode};

        let (rect, monitor_id) = live_test_region();
        let src_path = temp_path("slickshot-live-export-src.mp4");
        let mp4 = temp_path("slickshot-live-export.mp4");
        let gif = temp_path("slickshot-live-export.gif");
        let backend = MacBackend;

        let recording = backend
            .start_recording(&RecordConfig {
                rect,
                monitor_id,
                fps: 30,
                show_cursor: true,
                system_audio: false,
                microphone: false,
                out_path: src_path,
            })
            .expect("start");
        std::thread::sleep(Duration::from_secs(3));
        let src = recording.stop().expect("stop");
        let before = backend.probe(&src).expect("probe");

        // Crop the top-left quarter, scale it to a fixed 320x240, black out a
        // corner, and stamp one opaque pixel over the censor.
        let crop = PhysRect::new(0, 0, before.width / 2, before.height / 2);
        let out_size = (320u32, 240u32);
        let censors = vec![Censor {
                start_ms: None,
                end_ms: None,
            rect: PhysRect::new(0, 0, 100, 100),
            mode: CensorMode::Solid { r: 0, g: 0, b: 0 },
        }];
        let mut overlay = RgbaImage::from_pixel(out_size.0, out_size.1, image::Rgba([0, 0, 0, 0]));
        overlay.put_pixel(50, 50, image::Rgba([255, 0, 0, 255]));

        let process = |frame: &mut RgbaImage| {
            *frame = transform::crop(frame, crop);
            *frame = transform::resize(frame, out_size.0, out_size.1);
            transform::apply_censors(frame, &censors);
            transform::composite_overlay(frame, &overlay);
        };

        let range = TimeRange {
            start_ms: 500,
            end_ms: 2_000,
        };
        let opts = TranscodeOptions {
            range,
            speed: 1.0,
            crop: Some(crop),
            output: out_size,
            keep_audio: false,
        };
        let mut out_pts: Vec<u64> = Vec::new();
        backend
            .transcode(&src, &mp4, &opts, &mut |mut frame| {
                process(&mut frame.image);
                out_pts.push(frame.pts_ms);
                Some(frame)
            })
            .expect("transcode");
        println!(
            "transcode pts: n={} first={:?} last={:?}",
            out_pts.len(),
            out_pts.first(),
            out_pts.last()
        );

        let after = backend.probe(&mp4).expect("probe mp4");
        println!(
            "mp4: {}x{} {}ms",
            after.width, after.height, after.duration_ms
        );
        assert_eq!((after.width, after.height), out_size);
        assert!(
            (1_400..=1_600).contains(&after.duration_ms),
            "expected about 1500ms, got {}ms",
            after.duration_ms
        );

        // The processing really reached the pixels: decode the export back and
        // look for the overlay dot sitting on top of the censored corner.
        let mut checked = false;
        backend
            .decode_frames(
                &mp4,
                TimeRange {
                    start_ms: 0,
                    end_ms: 1_000,
                },
                2,
                &mut |frame| {
                    if !checked {
                        checked = true;
                        let dot = frame.image.get_pixel(50, 50).0;
                        let censored = frame.image.get_pixel(20, 20).0;
                        println!("overlay pixel {dot:?}, censored pixel {censored:?}");
                        // H.264 is lossy, so this asks for "clearly red" and
                        // "clearly dark" rather than exact values.
                        assert!(
                            dot[0] > 150 && dot[1] < 110 && dot[2] < 110,
                            "the burnt-in overlay should still be red, got {dot:?}"
                        );
                        assert!(
                            censored.iter().take(3).all(|c| *c < 60),
                            "the censored corner should still be dark, got {censored:?}"
                        );
                    }
                    true
                },
            )
            .expect("decode the export");
        assert!(checked, "the export had no frames to check");

        // And the same pipeline into a GIF at 10fps.
        let mut frames = Vec::new();
        backend
            .decode_frames(&src, range, 10, &mut |mut frame| {
                process(&mut frame.image);
                frames.push(frame.image);
                true
            })
            .expect("decode for gif");
        println!("gif frames: {}", frames.len());
        assert!(
            (13..=17).contains(&frames.len()),
            "expected about 15 frames over 1.5s at 10fps, got {}",
            frames.len()
        );
        let file = std::fs::File::create(&gif).expect("create gif");
        crate::record::gif::encode(frames, 10, std::io::BufWriter::new(file)).expect("encode gif");

        let written = std::fs::metadata(&gif).expect("gif metadata").len();
        println!("gif bytes: {written}");
        assert!(written > 1_000, "the GIF looks empty at {written} bytes");
        let header = std::fs::read(&gif).expect("read gif");
        assert_eq!(&header[..6], b"GIF89a", "that is not a GIF");

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&mp4);
        let _ = std::fs::remove_file(&gif);
    }

    /// Live: records with both audio sources and checks the file really has
    /// two separate tracks.
    ///
    /// Needs Screen Recording *and* Microphone permission, and a default input
    /// device; run it by hand with
    /// `cargo test records_with_system_audio_and_mic -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn records_with_system_audio_and_mic() {
        let (rect, monitor_id) = live_test_region();
        let out = temp_path("slickshot-live-record-audio.mp4");
        let backend = MacBackend;

        let recording = backend
            .start_recording(&RecordConfig {
                rect,
                monitor_id,
                fps: 30,
                show_cursor: true,
                system_audio: true,
                microphone: true,
                out_path: out.clone(),
            })
            .expect("start");

        // Surfaced rather than asserted away: without microphone permission
        // the recording is still valid, just single-track, and the reason
        // should be readable in the test output instead of showing up as a
        // baffling "expected 2 tracks, got 1".
        let warnings = recording.warnings();
        for w in &warnings {
            println!("warning: {w}");
        }

        // Long runs are how drift is told apart from a fixed start-up offset,
        // so the length is a knob rather than a recompile.
        let seconds: u64 = std::env::var("SLICKSHOT_LIVE_RECORD_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5);
        println!("recording for {seconds}s");
        std::thread::sleep(Duration::from_secs(seconds));
        let path = recording.stop().expect("stop");

        let info = backend.probe(&path).expect("probe");
        println!(
            "probe: {}x{} {}ms {:.3}fps audio={} tracks={}",
            info.width, info.height, info.duration_ms, info.fps, info.has_audio, info.audio_tracks
        );
        assert!(info.has_audio, "system audio was requested but none landed");

        let tracks = backend.track_offsets(&path).expect("track offsets");
        for t in &tracks {
            println!(
                "track {}: first={:.3}ms last={:.3}ms samples={}",
                t.index, t.first_pts_ms, t.last_pts_ms, t.samples
            );
        }

        if warnings.is_empty() {
            assert_eq!(
                info.audio_tracks, 2,
                "system audio and microphone should be two separate tracks"
            );
            assert_eq!(tracks.len(), 2);
            // Both inputs are stamped against the screen stream's clock, so
            // they should begin and end together. 20ms is well under a frame
            // at 30fps -- past that, the drift correction is not working.
            let start_skew = (tracks[1].first_pts_ms - tracks[0].first_pts_ms).abs();
            let end_skew = (tracks[1].last_pts_ms - tracks[0].last_pts_ms).abs();
            println!("skew: start={start_skew:.3}ms end={end_skew:.3}ms");
            // Where the two tracks *end* is ragged by construction: one AAC
            // packet is already 21ms, the microphone needs ~100ms to spin up,
            // and stopping marks the two inputs finished microseconds apart.
            // What would be a bug is that gap growing with the recording's
            // length -- measured at 83ms over 5s and 69ms over 60s, so it does
            // not accumulate. Sample-level alignment is checked separately by
            // cross-correlating a click track (scripts/check_track_sync.py).
            assert!(
                end_skew < 200.0,
                "the tracks ended {end_skew:.3}ms apart, far past a boundary effect"
            );
        } else {
            assert_eq!(
                info.audio_tracks, 1,
                "with the microphone unavailable, only system audio should be written"
            );
        }

        for t in &tracks {
            assert!(t.samples > 0, "track {} carries no samples", t.index);
        }
        // Kept when asked for, so the sync script has something to analyse.
        if std::env::var("SLICKSHOT_LIVE_RECORD_KEEP").is_ok() {
            println!("kept: {}", path.display());
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}
