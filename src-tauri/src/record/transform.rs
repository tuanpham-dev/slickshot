//! Every pixel transform the video editor applies, as pure functions over
//! `RgbaImage`. Kept platform-independent on purpose: the three recording
//! backends differ only in how they get frames in and out, so crop, resize,
//! compositing, censoring and speed all belong here where they can be tested
//! without a screen or an encoder.

// Exercised by this module's own tests today; the export pipeline that
// calls it in production lands with the editor's Save (plan T4.1-T4.4).
#![allow(dead_code)]
use image::{imageops, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::geometry::PhysRect;

/// How a censor covers what's under it. Applied per frame rather than baked
/// into the annotation overlay, because a censor flattened from one paused
/// frame would expose whatever moved beneath it in every other frame.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CensorMode {
    Pixelate { block: u32 },
    Solid { r: u8, g: u8, b: u8 },
    Blur { sigma: f32 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Censor {
    pub rect: PhysRect,
    #[serde(flatten)]
    pub mode: CensorMode,
}

/// Clamps `rect` to the frame and returns it in pixel coordinates, or `None`
/// when nothing of it lands inside.
fn clamped(frame: &RgbaImage, rect: PhysRect) -> Option<(u32, u32, u32, u32)> {
    let bounds = PhysRect::new(0, 0, frame.width(), frame.height());
    let r = bounds.intersect(&rect)?;
    Some((r.x as u32, r.y as u32, r.w, r.h))
}

/// Crops to `rect`, clamped to the frame. A rect entirely outside the frame
/// yields a 1x1 image rather than a zero-sized one, which no encoder accepts.
pub fn crop(frame: &RgbaImage, rect: PhysRect) -> RgbaImage {
    match clamped(frame, rect) {
        Some((x, y, w, h)) => imageops::crop_imm(frame, x, y, w, h).to_image(),
        None => RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255])),
    }
}

pub fn resize(frame: &RgbaImage, w: u32, h: u32) -> RgbaImage {
    if frame.width() == w && frame.height() == h {
        return frame.clone();
    }
    imageops::resize(frame, w.max(1), h.max(1), imageops::FilterType::Triangle)
}

/// Alpha-blends `overlay` onto `frame` at the origin. The overlay is the
/// editor's own annotation layer flattened to a transparent PNG, so it is
/// already in source-pixel coordinates and the same size as the frame it
/// belongs to; a mismatched size composites over the shared top-left region
/// rather than failing, which is what keeps a crop from having to resize the
/// overlay separately.
pub fn composite_overlay(frame: &mut RgbaImage, overlay: &RgbaImage) {
    let w = frame.width().min(overlay.width());
    let h = frame.height().min(overlay.height());
    for y in 0..h {
        for x in 0..w {
            let src = overlay.get_pixel(x, y).0;
            let a = src[3] as u32;
            if a == 0 {
                continue;
            }
            if a == 255 {
                frame.put_pixel(x, y, Rgba(src));
                continue;
            }
            let dst = frame.get_pixel(x, y).0;
            let inv = 255 - a;
            let blend = |s: u8, d: u8| ((s as u32 * a + d as u32 * inv) / 255) as u8;
            frame.put_pixel(
                x,
                y,
                Rgba([
                    blend(src[0], dst[0]),
                    blend(src[1], dst[1]),
                    blend(src[2], dst[2]),
                    255,
                ]),
            );
        }
    }
}

/// Upper bound on blur cost: a large sigma on a full-frame censor is slow
/// enough to stall an export, and past this it is visually indistinguishable
/// from the next value up anyway.
const MAX_BLUR_SIGMA: f32 = 12.0;

pub fn apply_censors(frame: &mut RgbaImage, censors: &[Censor]) {
    for censor in censors {
        let Some((x, y, w, h)) = clamped(frame, censor.rect) else {
            continue;
        };
        match censor.mode {
            CensorMode::Solid { r, g, b } => {
                for py in y..y + h {
                    for px in x..x + w {
                        frame.put_pixel(px, py, Rgba([r, g, b, 255]));
                    }
                }
            }
            CensorMode::Pixelate { block } => {
                let block = block.max(1);
                for by in (y..y + h).step_by(block as usize) {
                    for bx in (x..x + w).step_by(block as usize) {
                        let bw = block.min(x + w - bx);
                        let bh = block.min(y + h - by);
                        let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                        let count = (bw * bh).max(1);
                        for py in by..by + bh {
                            for px in bx..bx + bw {
                                let p = frame.get_pixel(px, py).0;
                                r += p[0] as u32;
                                g += p[1] as u32;
                                b += p[2] as u32;
                            }
                        }
                        let avg = Rgba([
                            (r / count) as u8,
                            (g / count) as u8,
                            (b / count) as u8,
                            255,
                        ]);
                        for py in by..by + bh {
                            for px in bx..bx + bw {
                                frame.put_pixel(px, py, avg);
                            }
                        }
                    }
                }
            }
            CensorMode::Blur { sigma } => {
                let sub = imageops::crop_imm(frame, x, y, w, h).to_image();
                let blurred = imageops::blur(&sub, sigma.clamp(0.1, MAX_BLUR_SIGMA));
                imageops::replace(frame, &blurred, x as i64, y as i64);
            }
        }
    }
}

/// Maps a source frame's timestamp onto the output timeline at a given speed,
/// emitting the output timestamps that frame should occupy.
///
/// Slower than 1x needs a frame to be held for several output slots
/// (duplicated); faster drops most of them. Driving this off the output
/// frame grid rather than scaling each PTS keeps the output at a constant
/// frame rate, which is what encoders and GIF delays both want.
pub struct SpeedResampler {
    out_interval_ms: f64,
    speed: f64,
    /// Index of the next output frame slot not yet emitted.
    next_slot: u64,
}

impl SpeedResampler {
    pub fn new(out_fps: u32, speed: f32) -> Self {
        Self {
            out_interval_ms: 1000.0 / out_fps.max(1) as f64,
            speed: (speed as f64).max(0.01),
            next_slot: 0,
        }
    }

    /// Output timestamps this source frame covers. Empty means the frame is
    /// dropped, which is what speeding up mostly does.
    ///
    /// A frame claims every output slot up to its own position on the
    /// compressed timeline: at 2x most frames land behind the slot grid and
    /// claim nothing, at 0.5x each one claims two. No knowledge of the source
    /// frame rate is needed, which matters because a screen recording's
    /// actual rate wanders with how much is moving.
    pub fn next(&mut self, src_pts_ms: u64) -> Vec<u64> {
        let out_time = src_pts_ms as f64 / self.speed;
        let mut stamps = Vec::new();
        while self.next_slot as f64 * self.out_interval_ms <= out_time {
            stamps.push((self.next_slot as f64 * self.out_interval_ms).round() as u64);
            self.next_slot += 1;
            // A pathological pts jump (a corrupt file, a huge gap) must not
            // spin here filling memory with duplicate frames.
            if stamps.len() >= 512 {
                break;
            }
        }
        stamps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(px))
    }

    #[test]
    fn crop_clamps_to_the_frame() {
        let img = solid(100, 100, [10, 20, 30, 255]);
        let out = crop(&img, PhysRect::new(80, 80, 40, 40));
        assert_eq!((out.width(), out.height()), (20, 20), "clipped at the edge");
    }

    #[test]
    fn crop_entirely_outside_yields_a_usable_frame() {
        let img = solid(100, 100, [10, 20, 30, 255]);
        let out = crop(&img, PhysRect::new(500, 500, 40, 40));
        assert_eq!((out.width(), out.height()), (1, 1), "encoders reject 0x0");
    }

    #[test]
    fn overlay_blends_by_alpha() {
        let mut frame = solid(2, 2, [0, 0, 0, 255]);
        let mut overlay = solid(2, 2, [255, 255, 255, 0]);
        overlay.put_pixel(0, 0, Rgba([255, 0, 0, 255])); // opaque red
        overlay.put_pixel(1, 0, Rgba([255, 255, 255, 128])); // half white
        composite_overlay(&mut frame, &overlay);

        assert_eq!(frame.get_pixel(0, 0).0, [255, 0, 0, 255], "opaque replaces");
        let half = frame.get_pixel(1, 0).0;
        assert!(
            (half[0] as i32 - 128).abs() <= 1,
            "half alpha blends halfway, got {half:?}"
        );
        assert_eq!(
            frame.get_pixel(0, 1).0,
            [0, 0, 0, 255],
            "fully transparent leaves the frame alone"
        );
    }

    #[test]
    fn pixelate_makes_each_block_uniform() {
        let mut frame = RgbaImage::new(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                frame.put_pixel(x, y, Rgba([(x * 30) as u8, (y * 30) as u8, 0, 255]));
            }
        }
        apply_censors(
            &mut frame,
            &[Censor {
                rect: PhysRect::new(0, 0, 8, 8),
                mode: CensorMode::Pixelate { block: 8 },
            }],
        );
        let first = frame.get_pixel(0, 0).0;
        for y in 0..8 {
            for x in 0..8 {
                assert_eq!(frame.get_pixel(x, y).0, first, "one 8x8 block is flat");
            }
        }
    }

    #[test]
    fn solid_censor_fills_exactly_its_rect() {
        let mut frame = solid(10, 10, [9, 9, 9, 255]);
        apply_censors(
            &mut frame,
            &[Censor {
                rect: PhysRect::new(2, 2, 3, 3),
                mode: CensorMode::Solid { r: 255, g: 0, b: 0 },
            }],
        );
        assert_eq!(frame.get_pixel(2, 2).0, [255, 0, 0, 255]);
        assert_eq!(frame.get_pixel(4, 4).0, [255, 0, 0, 255]);
        assert_eq!(frame.get_pixel(5, 5).0, [9, 9, 9, 255], "outside untouched");
        assert_eq!(frame.get_pixel(1, 1).0, [9, 9, 9, 255]);
    }

    #[test]
    fn blur_censor_reduces_variance() {
        let mut frame = RgbaImage::new(20, 20);
        for y in 0..20 {
            for x in 0..20 {
                let v = if (x + y) % 2 == 0 { 0 } else { 255 };
                frame.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        let before: i64 = frame.pixels().map(|p| p.0[0] as i64).sum();
        apply_censors(
            &mut frame,
            &[Censor {
                rect: PhysRect::new(0, 0, 20, 20),
                mode: CensorMode::Blur { sigma: 4.0 },
            }],
        );
        let mean = before / 400;
        let variance: i64 = frame
            .pixels()
            .map(|p| (p.0[0] as i64 - mean).pow(2))
            .sum::<i64>()
            / 400;
        assert!(variance < 4000, "checkerboard should smooth out, got {variance}");
    }

    #[test]
    fn censor_outside_the_frame_is_skipped() {
        let mut frame = solid(10, 10, [1, 2, 3, 255]);
        apply_censors(
            &mut frame,
            &[Censor {
                rect: PhysRect::new(50, 50, 10, 10),
                mode: CensorMode::Solid { r: 255, g: 0, b: 0 },
            }],
        );
        assert_eq!(frame.get_pixel(9, 9).0, [1, 2, 3, 255]);
    }

    /// Feeds 100 source frames at 30fps through the resampler and counts the
    /// output slots they land on -- the count is what actually determines the
    /// exported clip's length.
    fn emitted_stamps(speed: f32) -> Vec<u64> {
        let mut r = SpeedResampler::new(30, speed);
        let mut out = Vec::new();
        for i in 0..100u64 {
            out.extend(r.next(i * 1000 / 30));
        }
        out
    }

    #[test]
    fn speed_1x_keeps_one_slot_per_frame() {
        let stamps = emitted_stamps(1.0);
        assert!(
            (95..=105).contains(&stamps.len()),
            "1x should be about 1:1, got {}",
            stamps.len()
        );
    }

    #[test]
    fn speed_2x_halves_the_output() {
        let stamps = emitted_stamps(2.0);
        assert!(
            (45..=55).contains(&stamps.len()),
            "2x should emit about half, got {}",
            stamps.len()
        );
    }

    #[test]
    fn speed_half_doubles_the_output() {
        let stamps = emitted_stamps(0.5);
        assert!(
            (190..=210).contains(&stamps.len()),
            "0.5x should emit about double, got {}",
            stamps.len()
        );
    }

    #[test]
    fn output_stamps_are_monotonic() {
        for speed in [0.5f32, 1.0, 2.0, 4.0] {
            let stamps = emitted_stamps(speed);
            assert!(
                stamps.windows(2).all(|w| w[1] > w[0]),
                "timestamps must strictly increase at {speed}x"
            );
        }
    }
}
