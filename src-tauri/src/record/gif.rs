//! GIF export. A recording is always MP4 on disk; GIF is something the editor
//! produces from it, so this only has to turn a stream of already-transformed
//! frames into a file.
//!
//! Frames are written as difference rectangles over a `Keep` disposal: only
//! the bounding box that actually changed since the previous frame is encoded.
//! On screen recordings -- where most of the frame is a static window -- that
//! is the difference between a usable file and a hundred-megabyte one.

// Written and tested ahead of the export path that calls it (plan T4.5).
#![allow(dead_code)]
use std::io::Write;

// `::gif` rather than `gif`: this module is itself named `gif`, so the bare
// path would resolve to it instead of the crate.
use ::gif::{DisposalMethod, Encoder, Frame, Repeat};
use image::RgbaImage;

use super::{RecordError, RecordResult};

/// Smallest delay a GIF can express is 10ms (the format stores hundredths of
/// a second), and most decoders treat 0-1 as "as fast as possible" rather
/// than honouring it -- so anything faster than 100fps is clamped here.
const MIN_DELAY_HUNDREDTHS: u16 = 2;

/// The bounding box of pixels that differ between two frames, or `None` when
/// they are identical.
fn diff_bounds(prev: &RgbaImage, next: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
    if prev.dimensions() != next.dimensions() {
        return Some((0, 0, next.width(), next.height()));
    }
    let (w, h) = next.dimensions();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            if prev.get_pixel(x, y) != next.get_pixel(x, y) {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if min_x > max_x {
        return None;
    }
    Some((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
}

/// Encodes `frames` (already cropped, resized and composited) as an
/// infinitely looping GIF at `fps`.
///
/// `speed` is the `gif` crate's quantizer speed knob: 10 is its own default
/// and keeps a long screen recording's export from taking minutes, at a
/// quality cost that does not show on UI content.
pub fn encode<W: Write>(
    frames: impl IntoIterator<Item = RgbaImage>,
    fps: u32,
    out: W,
) -> RecordResult<()> {
    let delay = ((100.0 / fps.max(1) as f32).round() as u16).max(MIN_DELAY_HUNDREDTHS);

    let mut iter = frames.into_iter();
    let Some(first) = iter.next() else {
        return Err(RecordError::Backend(
            "there are no frames in the selected range".into(),
        ));
    };

    let (w, h) = first.dimensions();
    let (w16, h16) = (
        u16::try_from(w).map_err(|_| RecordError::Backend("the GIF is too wide".into()))?,
        u16::try_from(h).map_err(|_| RecordError::Backend("the GIF is too tall".into()))?,
    );

    let mut encoder =
        Encoder::new(out, w16, h16, &[]).map_err(|e| RecordError::Backend(e.to_string()))?;
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| RecordError::Backend(e.to_string()))?;

    let mut buf = first.as_raw().clone();
    let mut frame = Frame::from_rgba_speed(w16, h16, &mut buf, 10);
    frame.delay = delay;
    frame.dispose = DisposalMethod::Keep;
    encoder
        .write_frame(&frame)
        .map_err(|e| RecordError::Backend(e.to_string()))?;

    let mut prev = first;
    for next in iter {
        match diff_bounds(&prev, &next) {
            // Nothing moved: rather than writing a whole redundant frame,
            // lengthen the one already on screen.
            None => {}
            Some((x, y, dw, dh)) => {
                let sub = image::imageops::crop_imm(&next, x, y, dw, dh).to_image();
                let mut sub_buf = sub.as_raw().clone();
                let mut f = Frame::from_rgba_speed(
                    dw as u16,
                    dh as u16,
                    &mut sub_buf,
                    10,
                );
                f.left = x as u16;
                f.top = y as u16;
                f.delay = delay;
                f.dispose = DisposalMethod::Keep;
                encoder
                    .write_frame(&f)
                    .map_err(|e| RecordError::Backend(e.to_string()))?;
            }
        }
        prev = next;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn frame(w: u32, h: u32, v: u8) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([v, v, v, 255]))
    }

    #[test]
    fn diff_of_identical_frames_is_none() {
        let a = frame(4, 4, 10);
        assert!(diff_bounds(&a, &a.clone()).is_none());
    }

    #[test]
    fn diff_finds_the_changed_box() {
        let a = frame(10, 10, 0);
        let mut b = a.clone();
        b.put_pixel(3, 4, Rgba([255, 0, 0, 255]));
        b.put_pixel(5, 6, Rgba([255, 0, 0, 255]));
        assert_eq!(diff_bounds(&a, &b), Some((3, 4, 3, 3)));
    }

    #[test]
    fn encodes_a_decodable_looping_gif() {
        let frames: Vec<RgbaImage> = (0..10).map(|i| frame(8, 8, i * 20)).collect();
        let mut out = Vec::new();
        encode(frames, 10, &mut out).expect("encode");

        let mut options = ::gif::DecodeOptions::new();
        options.set_color_output(::gif::ColorOutput::RGBA);
        let mut decoder = options
            .read_info(std::io::Cursor::new(&out))
            .expect("decode header");
        assert_eq!((decoder.width(), decoder.height()), (8, 8));

        let mut count = 0;
        while let Some(f) = decoder.read_next_frame().expect("read frame") {
            assert_eq!(f.delay, 10, "10fps is 10 hundredths per frame");
            count += 1;
        }
        assert_eq!(count, 10, "every distinct frame is written");
    }

    #[test]
    fn identical_frames_are_not_rewritten() {
        let frames: Vec<RgbaImage> = std::iter::repeat_with(|| frame(8, 8, 42)).take(5).collect();
        let mut out = Vec::new();
        encode(frames, 10, &mut out).expect("encode");

        let mut decoder = ::gif::DecodeOptions::new()
            .read_info(std::io::Cursor::new(&out))
            .expect("decode header");
        let mut count = 0;
        while decoder.read_next_frame().expect("read frame").is_some() {
            count += 1;
        }
        assert_eq!(count, 1, "four unchanged frames add no data");
    }

    #[test]
    fn no_frames_is_an_error() {
        let mut out = Vec::new();
        assert!(encode(Vec::<RgbaImage>::new(), 10, &mut out).is_err());
    }
}
