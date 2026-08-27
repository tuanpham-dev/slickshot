use std::sync::Arc;

use image::{imageops, RgbaImage};

use crate::capture::{CaptureResult, MonitorInfo, ScreenCapturer};
use crate::geometry::PhysRect;

pub struct Frame {
    pub monitor: MonitorInfo,
    /// Arc so the frame can be shared with `ImageStore` (for the overlay's
    /// `slickshot://` fetch) without copying a full monitor's pixels.
    pub image: Arc<RgbaImage>,
}

pub struct CaptureSession {
    pub frames: Vec<Frame>,
    pub virtual_rect: PhysRect,
}

impl CaptureSession {
    pub fn grab(capturer: &dyn ScreenCapturer) -> CaptureResult<Self> {
        let monitors = capturer.monitors()?;

        // One capture thread per monitor: `capture_monitor` opens its own
        // X connection, so grabs are independent and the total wait is the
        // slowest monitor instead of the sum of all of them.
        let images: Vec<CaptureResult<RgbaImage>> = std::thread::scope(|scope| {
            let handles: Vec<_> = monitors
                .iter()
                .map(|m| {
                    let id = m.id;
                    scope.spawn(move || capturer.capture_monitor(id))
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("capture thread panicked"))
                .collect()
        });

        let mut frames = Vec::with_capacity(monitors.len());
        let mut virtual_rect: Option<PhysRect> = None;
        for (monitor, image) in monitors.into_iter().zip(images) {
            virtual_rect = Some(match virtual_rect {
                Some(r) => r.union(&monitor.rect),
                None => monitor.rect,
            });
            frames.push(Frame {
                monitor,
                image: Arc::new(image?),
            });
        }

        Ok(Self {
            frames,
            virtual_rect: virtual_rect.unwrap_or(PhysRect::new(0, 0, 0, 0)),
        })
    }

    /// Composites the given physical-pixel rect out of the frozen frames.
    /// Never re-captures the screen -- see the plan's Approach section.
    pub fn composite(&self, rect: PhysRect) -> RgbaImage {
        let mut out = RgbaImage::new(rect.w, rect.h);
        for frame in &self.frames {
            let Some(overlap) = frame.monitor.rect.intersect(&rect) else {
                continue;
            };
            let src_x = (overlap.x - frame.monitor.rect.x) as u32;
            let src_y = (overlap.y - frame.monitor.rect.y) as u32;
            let dst_x = overlap.x - rect.x;
            let dst_y = overlap.y - rect.y;

            let sub = imageops::crop_imm(frame.image.as_ref(), src_x, src_y, overlap.w, overlap.h)
                .to_image();
            imageops::replace(&mut out, &sub, dst_x as i64, dst_y as i64);
        }
        out
    }

    pub fn frame_for_monitor(&self, monitor_id: u32) -> Option<&Frame> {
        self.frames.iter().find(|f| f.monitor.id == monitor_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::MonitorInfo;
    use image::Rgba;

    fn solid(w: u32, h: u32, color: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(color))
    }

    #[test]
    fn composite_places_second_monitor_at_offset() {
        let frame_a = Frame {
            monitor: MonitorInfo {
                id: 1,
                name: "A".into(),
                rect: PhysRect::new(0, 0, 4, 4),
                is_primary: true,
            },
            image: Arc::new(solid(4, 4, [255, 0, 0, 255])),
        };
        let frame_b = Frame {
            monitor: MonitorInfo {
                id: 2,
                name: "B".into(),
                rect: PhysRect::new(2, 4, 4, 4),
                is_primary: false,
            },
            image: Arc::new(solid(4, 4, [0, 255, 0, 255])),
        };
        let virtual_rect = frame_a.monitor.rect.union(&frame_b.monitor.rect);
        let session = CaptureSession {
            frames: vec![frame_a, frame_b],
            virtual_rect,
        };

        let full = session.composite(virtual_rect);
        assert_eq!(full.get_pixel(0, 0), &Rgba([255, 0, 0, 255]));
        assert_eq!(full.get_pixel(2, 4), &Rgba([0, 255, 0, 255]));
        assert_eq!(full.get_pixel(5, 7), &Rgba([0, 255, 0, 255]));
        // area not covered by either monitor stays transparent
        assert_eq!(full.get_pixel(0, 4), &Rgba([0, 0, 0, 0]));
    }
}
