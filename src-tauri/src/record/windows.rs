//! Windows recording backend: `xcap` frames into a Media Foundation sink
//! writer.
//!
//! Media Foundation rather than a bundled encoder because it is in the OS and
//! uses whatever hardware H.264 encoder the machine has. No new C dependency,
//! which is the same rule the rest of this repo follows.
//!
//! **Unverified.** This has never been compiled: cross-checking from the
//! development machine fails inside `ring`, which needs a Windows C toolchain's
//! headers. See the T5.3 checklist in `docs/TESTING.md`.

use std::path::Path;

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::time::{Duration, Instant};

use super::{
    ActiveRecording, RecordConfig, RecordError, RecordResult, RgbaFrame, TimeRange,
    TranscodeOptions, VideoBackend, VideoInfo,
};

#[cfg(windows)]
use std::sync::Mutex;

#[cfg(windows)]
use image::RgbaImage;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Media::MediaFoundation::*;

#[cfg(windows)]
use super::transform::{self, FramePacer};

pub struct WindowsBackend;

/// Media Foundation counts in 100-nanosecond units ("reference time"), which
/// is neither seconds nor milliseconds and is the easiest thing in this file
/// to get wrong by three orders of magnitude.
pub const HNS_PER_MS: i64 = 10_000;

pub fn ms_to_hns(ms: u64) -> i64 {
    ms as i64 * HNS_PER_MS
}

pub fn hns_to_ms(hns: i64) -> u64 {
    (hns.max(0) / HNS_PER_MS) as u64
}

/// Even dimensions, which H.264 requires; an odd width fails inside the
/// encoder with an unhelpful `E_INVALIDARG`.
pub fn even_size(w: u32, h: u32) -> (u32, u32) {
    ((w & !1).max(2), (h & !1).max(2))
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn hr(e: windows::core::Error) -> RecordError {
    RecordError::Backend(e.message())
}

/// Starts Media Foundation once per process. `MFStartup` is reference counted,
/// but calling it per recording and never shutting down would leak a count, so
/// it is done once and left running for the app's lifetime.
#[cfg(windows)]
fn ensure_mf() -> RecordResult<()> {
    use std::sync::Once;
    static START: Once = Once::new();
    static mut RESULT: Option<String> = None;
    START.call_once(|| unsafe {
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
            RESULT = Some(e.message());
        }
    });
    // Safe: written once inside `call_once`, only read after it has returned.
    match unsafe { (*std::ptr::addr_of!(RESULT)).clone() } {
        Some(message) => Err(RecordError::Backend(message)),
        None => Ok(()),
    }
}

#[cfg(windows)]
struct WindowsRecording {
    writer: Arc<Mutex<Option<IMFSinkWriter>>>,
    running: Arc<AtomicBool>,
    started: Instant,
    out_path: std::path::PathBuf,
    capture: Option<std::thread::JoinHandle<()>>,
    warnings: Vec<String>,
}

#[cfg(windows)]
impl ActiveRecording for WindowsRecording {
    fn stop(mut self: Box<Self>) -> RecordResult<std::path::PathBuf> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture.take() {
            let _ = handle.join();
        }
        let writer = self.writer.lock().unwrap().take();
        if let Some(writer) = writer {
            // Finalize writes the index; without it the file has no moov and
            // nothing will play it.
            unsafe { writer.Finalize() }.map_err(hr)?;
        }
        Ok(self.out_path.clone())
    }

    fn cancel(mut self: Box<Self>) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture.take() {
            let _ = handle.join();
        }
        // Dropped without finalizing, then deleted.
        let _ = self.writer.lock().unwrap().take();
        let _ = std::fs::remove_file(&self.out_path);
    }

    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }
}

// The COM pointers are used only from the capture thread and the stopping
// thread, never concurrently -- the mutex is what enforces that.
#[cfg(windows)]
unsafe impl Send for WindowsRecording {}

impl VideoBackend for WindowsBackend {
    #[cfg(not(windows))]
    fn start_recording(&self, _cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        Err(RecordError::Unsupported("not Windows".into()))
    }

    #[cfg(windows)]
    fn start_recording(&self, cfg: &RecordConfig) -> RecordResult<Box<dyn ActiveRecording>> {
        ensure_mf()?;
        let (w, h) = even_size(cfg.rect.w, cfg.rect.h);

        let writer: IMFSinkWriter = unsafe {
            let attributes = {
                let mut attrs: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attrs, 1).map_err(hr)?;
                let attrs = attrs.ok_or_else(|| {
                    RecordError::Backend("couldn't create writer attributes".into())
                })?;
                // Without this the writer paces itself to real time and drops
                // frames whenever the encoder falls behind.
                attrs
                    .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)
                    .map_err(hr)?;
                attrs
            };
            MFCreateSinkWriterFromURL(
                PCWSTR(wide(&cfg.out_path).as_ptr()),
                None,
                &attributes,
                &mut None,
            )
            .map_err(hr)?
        };

        let stream_index = unsafe {
            // Output: H.264 at a bitrate scaled to the region and frame rate.
            let out_type: IMFMediaType = MFCreateMediaType().map_err(hr)?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(hr)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(hr)?;
            out_type
                .SetUINT32(
                    &MF_MT_AVG_BITRATE,
                    transform::bitrate_for(w, h, cfg.fps),
                )
                .map_err(hr)?;
            out_type
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(hr)?;
            set_frame_size(&out_type, w, h)?;
            set_ratio(&out_type, &MF_MT_FRAME_RATE, cfg.fps, 1)?;
            set_ratio(&out_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

            let index = writer.AddStream(&out_type).map_err(hr)?;

            // Input: uncompressed BGRA, which is what `MFVideoFormat_RGB32`
            // actually means on little-endian Windows.
            let in_type: IMFMediaType = MFCreateMediaType().map_err(hr)?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(hr)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(hr)?;
            in_type
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(hr)?;
            set_frame_size(&in_type, w, h)?;
            set_ratio(&in_type, &MF_MT_FRAME_RATE, cfg.fps, 1)?;
            set_ratio(&in_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            writer.SetInputMediaType(index, &in_type, None).map_err(hr)?;

            writer.BeginWriting().map_err(hr)?;
            index
        };

        let monitors = xcap::Monitor::all().map_err(|e| RecordError::Backend(e.to_string()))?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.id().map(|id| id == cfg.monitor_id).unwrap_or(false))
            .ok_or_else(|| RecordError::Backend("that monitor is gone".into()))?;

        // Global physical pixels on both sides, so this is a subtraction --
        // no scale factor, unlike the macOS path's points conversion.
        let crop = crate::geometry::PhysRect::new(
            cfg.rect.x - monitor.x().unwrap_or(0),
            cfg.rect.y - monitor.y().unwrap_or(0),
            w,
            h,
        );

        let shared = Arc::new(Mutex::new(Some(writer)));
        let running = Arc::new(AtomicBool::new(true));
        let started = Instant::now();

        let thread_writer = shared.clone();
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
                let Some(image) = RgbaImage::from_raw(frame.width, frame.height, frame.raw.clone())
                else {
                    continue;
                };
                let cropped = transform::crop(&image, crop);
                if cropped.dimensions() != (w, h) {
                    continue;
                }
                let mut bytes = cropped.into_raw();
                transform::swap_rb(&mut bytes);

                let guard = thread_writer.lock().unwrap();
                let Some(writer) = guard.as_ref() else { break };
                if write_frame(writer, stream_index, &bytes, w, h, elapsed_ms as u64, fps).is_err() {
                    break;
                }
            }
            let _ = recorder.stop();
        });

        Ok(Box::new(WindowsRecording {
            writer: shared,
            running,
            started,
            out_path: cfg.out_path.clone(),
            capture: Some(capture),
            warnings: if cfg.system_audio || cfg.microphone {
                vec!["Audio recording isn't available on Windows -- recording video only.".into()]
            } else {
                Vec::new()
            },
        }))
    }

    #[cfg(not(windows))]
    fn probe(&self, _path: &Path) -> RecordResult<VideoInfo> {
        Err(RecordError::Unsupported("not Windows".into()))
    }

    #[cfg(windows)]
    fn probe(&self, path: &Path) -> RecordResult<VideoInfo> {
        ensure_mf()?;
        unsafe {
            let reader = source_reader(path)?;
            let media = reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                .map_err(hr)?;
            let (width, height) = get_frame_size(&media)?;
            let (num, den) = get_ratio(&media, &MF_MT_FRAME_RATE).unwrap_or((0, 1));

            let duration = reader
                .GetPresentationAttribute(
                    MF_SOURCE_READER_MEDIASOURCE.0 as u32,
                    &MF_PD_DURATION,
                )
                .ok()
                .and_then(|v| v.try_into().ok())
                .unwrap_or(0i64);

            // A second video-less reader attempt is how audio presence is
            // established; there is no "count the tracks" call.
            let has_audio = reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32)
                .is_ok();

            Ok(VideoInfo {
                width,
                height,
                duration_ms: hns_to_ms(duration),
                fps: if den != 0 { num as f32 / den as f32 } else { 0.0 },
                has_audio,
                audio_tracks: u32::from(has_audio),
            })
        }
    }

    #[cfg(not(windows))]
    fn decode_frames(
        &self,
        _path: &Path,
        _range: TimeRange,
        _fps: u32,
        _on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        Err(RecordError::Unsupported("not Windows".into()))
    }

    #[cfg(windows)]
    fn decode_frames(
        &self,
        path: &Path,
        range: TimeRange,
        fps: u32,
        on_frame: &mut dyn FnMut(RgbaFrame) -> bool,
    ) -> RecordResult<()> {
        ensure_mf()?;
        unsafe {
            let reader = source_reader(path)?;
            let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

            // Ask the reader for plain BGRA; MF_SOURCE_READER_ENABLE_VIDEO_
            // PROCESSING (set in `source_reader`) is what lets it convert.
            let want: IMFMediaType = MFCreateMediaType().map_err(hr)?;
            want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(hr)?;
            want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(hr)?;
            reader.SetCurrentMediaType(stream, None, &want).map_err(hr)?;

            let media = reader.GetCurrentMediaType(stream).map_err(hr)?;
            let (width, height) = get_frame_size(&media)?;

            if range.start_ms > 0 {
                let position: windows::Win32::System::Variant::VARIANT =
                    ms_to_hns(range.start_ms).into();
                reader
                    .SetCurrentPosition(&windows::core::GUID::zeroed(), &position)
                    .map_err(hr)?;
            }

            // Same contract as the other backends: an even 1/fps grid with the
            // last frame held across gaps, so a still stretch yields repeated
            // frames rather than none.
            let interval_ms = if fps > 0 { 1000.0 / fps as f64 } else { 0.0 };
            let mut next_slot = range.start_ms as f64;
            let mut held: Option<RgbaImage> = None;
            let mut keep_going = true;

            while keep_going {
                let mut flags = 0u32;
                let mut timestamp = 0i64;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(
                        stream,
                        0,
                        None,
                        Some(&mut flags),
                        Some(&mut timestamp),
                        Some(&mut sample),
                    )
                    .map_err(hr)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    break;
                }
                let Some(sample) = sample else { continue };
                let pts_ms = hns_to_ms(timestamp);
                if pts_ms > range.end_ms {
                    break;
                }

                let buffer = sample.ConvertToContiguousBuffer().map_err(hr)?;
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut len = 0u32;
                buffer
                    .Lock(&mut data, None, Some(&mut len))
                    .map_err(hr)?;
                let mut bytes = std::slice::from_raw_parts(data, len as usize).to_vec();
                let _ = buffer.Unlock();
                transform::swap_rb(&mut bytes);

                let Some(image) = RgbaImage::from_raw(width, height, bytes) else {
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
            Ok(())
        }
    }

    #[cfg(not(windows))]
    fn transcode(
        &self,
        _src: &Path,
        _dst: &Path,
        _opts: &TranscodeOptions,
        _process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        Err(RecordError::Unsupported("not Windows".into()))
    }

    #[cfg(windows)]
    fn transcode(
        &self,
        src: &Path,
        dst: &Path,
        opts: &TranscodeOptions,
        process: &mut dyn FnMut(RgbaFrame) -> Option<RgbaFrame>,
    ) -> RecordResult<()> {
        ensure_mf()?;
        let (out_w, out_h) = even_size(opts.output.0, opts.output.1);
        let fps = 30u32;

        let writer: IMFSinkWriter = unsafe {
            MFCreateSinkWriterFromURL(PCWSTR(wide(dst).as_ptr()), None, None, &mut None)
                .map_err(hr)?
        };
        let stream_index = unsafe {
            let out_type: IMFMediaType = MFCreateMediaType().map_err(hr)?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(hr)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(hr)?;
            out_type
                .SetUINT32(&MF_MT_AVG_BITRATE, transform::bitrate_for(out_w, out_h, fps))
                .map_err(hr)?;
            out_type
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(hr)?;
            set_frame_size(&out_type, out_w, out_h)?;
            set_ratio(&out_type, &MF_MT_FRAME_RATE, fps, 1)?;
            set_ratio(&out_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            let index = writer.AddStream(&out_type).map_err(hr)?;

            let in_type: IMFMediaType = MFCreateMediaType().map_err(hr)?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(hr)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(hr)?;
            in_type
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(hr)?;
            set_frame_size(&in_type, out_w, out_h)?;
            set_ratio(&in_type, &MF_MT_FRAME_RATE, fps, 1)?;
            set_ratio(&in_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            writer.SetInputMediaType(index, &in_type, None).map_err(hr)?;
            writer.BeginWriting().map_err(hr)?;
            index
        };

        // Audio is dropped rather than passed through: the speed change would
        // need a pitch-corrected time-stretch Media Foundation has no simple
        // equivalent of, so the macOS-only note in the docs covers this too.
        let start = opts.range.start_ms;
        let speed = opts.speed.max(0.01) as f64;
        let mut failure: Option<String> = None;

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
            let mut bytes = processed.image.into_raw();
            transform::swap_rb(&mut bytes);
            if let Err(e) = write_frame(
                &writer,
                stream_index,
                &bytes,
                out_w,
                out_h,
                processed.pts_ms,
                fps,
            ) {
                failure = Some(e.to_string());
                return false;
            }
            true
        })?;

        unsafe { writer.Finalize() }.map_err(hr)?;
        match failure {
            Some(message) => Err(RecordError::Backend(message)),
            None => Ok(()),
        }
    }

    #[cfg(not(windows))]
    fn poster(&self, _src: &Path, _dst: &Path) -> RecordResult<()> {
        Err(RecordError::Unsupported("not Windows".into()))
    }

    #[cfg(windows)]
    fn poster(&self, src: &Path, dst: &Path) -> RecordResult<()> {
        let info = self.probe(src)?;
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

// -- Media Foundation helpers ----------------------------------------------
//
// Frame size and frame rate are both stored as one 64-bit attribute holding
// two 32-bit halves. Packing them by hand is the classic way to get a silently
// transposed width and height, so it happens in exactly these two places.

#[cfg(windows)]
fn set_frame_size(media: &IMFMediaType, w: u32, h: u32) -> RecordResult<()> {
    unsafe { media.SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64) }.map_err(hr)
}

#[cfg(windows)]
fn get_frame_size(media: &IMFMediaType) -> RecordResult<(u32, u32)> {
    let packed = unsafe { media.GetUINT64(&MF_MT_FRAME_SIZE) }.map_err(hr)?;
    Ok(((packed >> 32) as u32, (packed & 0xffff_ffff) as u32))
}

#[cfg(windows)]
fn set_ratio(
    media: &IMFMediaType,
    key: &windows::core::GUID,
    num: u32,
    den: u32,
) -> RecordResult<()> {
    unsafe { media.SetUINT64(key, ((num as u64) << 32) | den as u64) }.map_err(hr)
}

#[cfg(windows)]
fn get_ratio(media: &IMFMediaType, key: &windows::core::GUID) -> Option<(u32, u32)> {
    let packed = unsafe { media.GetUINT64(key) }.ok()?;
    Some(((packed >> 32) as u32, (packed & 0xffff_ffff) as u32))
}

#[cfg(windows)]
fn source_reader(path: &Path) -> RecordResult<IMFSourceReader> {
    unsafe {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 1).map_err(hr)?;
        let attrs =
            attrs.ok_or_else(|| RecordError::Backend("couldn't create reader attributes".into()))?;
        // Lets the reader convert to RGB32 for us instead of us wiring a
        // colour-conversion transform by hand.
        attrs
            .SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)
            .map_err(hr)?;
        MFCreateSourceReaderFromURL(PCWSTR(wide(path).as_ptr()), &attrs).map_err(hr)
    }
}

/// Wraps one frame's bytes in an `IMFSample` and writes it.
#[cfg(windows)]
fn write_frame(
    writer: &IMFSinkWriter,
    stream: u32,
    bytes: &[u8],
    w: u32,
    h: u32,
    pts_ms: u64,
    fps: u32,
) -> RecordResult<()> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(bytes.len() as u32).map_err(hr)?;
        let mut dst: *mut u8 = std::ptr::null_mut();
        buffer.Lock(&mut dst, None, None).map_err(hr)?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        let _ = buffer.Unlock();
        buffer.SetCurrentLength(bytes.len() as u32).map_err(hr)?;
        // Stride is implied by the buffer length for RGB32; the row length
        // has to match w*4 exactly or the picture shears.
        debug_assert_eq!(bytes.len(), (w * h * 4) as usize);

        let sample = MFCreateSample().map_err(hr)?;
        sample.AddBuffer(&buffer).map_err(hr)?;
        sample.SetSampleTime(ms_to_hns(pts_ms)).map_err(hr)?;
        sample
            .SetSampleDuration(HNS_PER_MS * (1000 / fps.max(1) as i64))
            .map_err(hr)?;
        writer.WriteSample(stream, &sample).map_err(hr)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_time_round_trips_through_milliseconds() {
        // 100ns units: a factor of 10,000 from milliseconds, and getting this
        // wrong by an order of magnitude makes every recording play at the
        // wrong speed rather than fail outright.
        assert_eq!(ms_to_hns(1), 10_000);
        assert_eq!(ms_to_hns(1_000), 10_000_000);
        assert_eq!(hns_to_ms(10_000_000), 1_000);
        for ms in [0u64, 1, 33, 1_000, 123_456] {
            assert_eq!(hns_to_ms(ms_to_hns(ms)), ms);
        }
    }

    #[test]
    fn a_negative_timestamp_reads_as_zero() {
        assert_eq!(hns_to_ms(-5), 0);
    }

    #[test]
    fn sizes_are_rounded_down_to_even() {
        assert_eq!(even_size(1921, 1081), (1920, 1080));
        assert_eq!(even_size(1920, 1080), (1920, 1080));
    }

    #[test]
    fn a_degenerate_size_still_encodes() {
        // H.264 cannot do 0- or 1-pixel dimensions; clamping beats failing
        // inside the encoder with E_INVALIDARG.
        assert_eq!(even_size(0, 1), (2, 2));
    }
}
