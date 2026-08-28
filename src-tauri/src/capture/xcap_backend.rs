use image::RgbaImage;

use super::{CaptureError, CaptureResult, MonitorInfo, ScreenCapturer, WindowInfo};
use crate::geometry::PhysRect;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

pub struct XcapCapturer;

impl XcapCapturer {
    pub fn new() -> Self {
        Self
    }
}

impl Default for XcapCapturer {
    fn default() -> Self {
        Self::new()
    }
}

impl ScreenCapturer for XcapCapturer {
    fn monitors(&self) -> CaptureResult<Vec<MonitorInfo>> {
        platform::monitors()
    }

    fn capture_monitor(&self, id: u32) -> CaptureResult<RgbaImage> {
        let monitors =
            xcap::Monitor::all().map_err(|e| CaptureError::Backend(e.to_string()))?;
        let monitor = monitors
            .iter()
            .find(|m| m.id().map(|mid| mid == id).unwrap_or(false))
            .ok_or(CaptureError::MonitorNotFound(id))?;

        let expected = platform::monitors()?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or(CaptureError::MonitorNotFound(id))?;

        let image = monitor
            .capture_image()
            .map_err(|e| CaptureError::Backend(e.to_string()))?;

        if image.width() != expected.rect.w || image.height() != expected.rect.h {
            return Err(CaptureError::SizeMismatch {
                got_w: image.width(),
                got_h: image.height(),
                expected_w: expected.rect.w,
                expected_h: expected.rect.h,
            });
        }

        Ok(image)
    }

    fn windows(&self) -> CaptureResult<Vec<WindowInfo>> {
        platform::windows()
    }

    fn capture_window(&self, id: u32) -> CaptureResult<RgbaImage> {
        let windows = xcap::Window::all().map_err(|e| CaptureError::Backend(e.to_string()))?;
        let window = windows
            .iter()
            .find(|w| w.id().map(|wid| wid == id).unwrap_or(false))
            .ok_or(CaptureError::WindowNotFound(id))?;

        window
            .capture_image()
            .map_err(|e| CaptureError::Backend(e.to_string()))
    }
}

/// Shared by platforms where `xcap`'s window `x/y/width/height()` already
/// report physical pixels in the global virtual-screen space (Linux X11,
/// Windows) -- see the macOS module below for the platform that needs a
/// unit conversion instead of a passthrough.
#[cfg(not(target_os = "macos"))]
fn generic_windows() -> CaptureResult<Vec<WindowInfo>> {
    let windows = xcap::Window::all().map_err(|e| CaptureError::Backend(e.to_string()))?;

    let mut out = Vec::new();
    for w in windows {
        let is_minimized = w.is_minimized().unwrap_or(false);
        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);
        if is_minimized || width == 0 || height == 0 {
            continue;
        }
        out.push(WindowInfo {
            id: w.id().map_err(|e| CaptureError::Backend(e.to_string()))?,
            title: w.title().unwrap_or_default(),
            app_name: w.app_name().unwrap_or_default(),
            rect: PhysRect::new(w.x().unwrap_or(0), w.y().unwrap_or(0), width, height),
        });
    }
    Ok(out)
}

/// Monitor geometry sourced directly from X11 RandR, bypassing `xcap`'s
/// `Monitor::x/y/width/height()` getters -- those divide the RandR monitor
/// rect (already the true physical/framebuffer pixel geometry, correctly
/// reflecting any per-monitor xrandr `--scale` transform) by a single
/// *global* desktop scale factor (from `Xft.dpi`/`GDK_SCALE`), which is
/// wrong whenever monitors have different physical pixel densities. Confirmed
/// by reading xcap 0.9.8's `linux/impl_monitor.rs`: `width()`/`height()`
/// return `raw_width / global_scale_factor`, while `capture_image()` grabs
/// the *raw* RandR rect (correct). We use `xcap::Monitor::capture_image()`
/// for pixel data (matched by RandR output XID) and this module for geometry.
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use x11rb::connection::Connection;
    use x11rb::protocol::randr::ConnectionExt as _;
    use x11rb::protocol::xproto::ConnectionExt as _;

    pub fn monitors() -> CaptureResult<Vec<MonitorInfo>> {
        let (conn, screen_num) =
            x11rb::connect(None).map_err(|e| CaptureError::Backend(e.to_string()))?;
        let root = conn.setup().roots[screen_num].root;

        let reply = conn
            .randr_get_monitors(root, true)
            .map_err(|e| CaptureError::Backend(e.to_string()))?
            .reply()
            .map_err(|e| CaptureError::Backend(e.to_string()))?;

        let mut out = Vec::with_capacity(reply.monitors.len());
        for m in reply.monitors {
            let name = conn
                .get_atom_name(m.name)
                .map_err(|e| CaptureError::Backend(e.to_string()))?
                .reply()
                .map(|r| String::from_utf8_lossy(&r.name).into_owned())
                .unwrap_or_default();

            let id = *m
                .outputs
                .first()
                .ok_or_else(|| CaptureError::Backend("monitor has no outputs".into()))?;

            out.push(MonitorInfo {
                id,
                name,
                rect: PhysRect::new(m.x as i32, m.y as i32, m.width as u32, m.height as u32),
                is_primary: m.primary,
            });
        }
        Ok(out)
    }

    pub fn windows() -> CaptureResult<Vec<WindowInfo>> {
        super::generic_windows()
    }
}

/// Windows' `DEVMODEW`-derived geometry (what `xcap`'s own getters read, via
/// `EnumDisplaySettingsW`) is already true physical pixels in the shared
/// virtual-desktop space -- `dmPosition`/`dmPelsWidth`/`dmPelsHeight` are
/// per-monitor absolute values, not divided by any global scale factor.
/// Windows' per-monitor-DPI-awareness model means there's no equivalent of
/// the Linux bug above, so this is a thin passthrough rather than a
/// from-scratch geometry query.
#[cfg(target_os = "windows")]
mod windows {
    use super::*;

    pub fn monitors() -> CaptureResult<Vec<MonitorInfo>> {
        let monitors =
            xcap::Monitor::all().map_err(|e| CaptureError::Backend(e.to_string()))?;

        monitors
            .iter()
            .map(|m| {
                Ok(MonitorInfo {
                    id: m.id().map_err(|e| CaptureError::Backend(e.to_string()))?,
                    name: m.name().unwrap_or_default(),
                    rect: PhysRect::new(
                        m.x().map_err(|e| CaptureError::Backend(e.to_string()))?,
                        m.y().map_err(|e| CaptureError::Backend(e.to_string()))?,
                        m.width().map_err(|e| CaptureError::Backend(e.to_string()))?,
                        m.height().map_err(|e| CaptureError::Backend(e.to_string()))?,
                    ),
                    is_primary: m.is_primary().unwrap_or(false),
                })
            })
            .collect()
    }

    pub fn windows() -> CaptureResult<Vec<WindowInfo>> {
        super::generic_windows()
    }
}

/// `xcap`'s macOS backend reports `x/y/width/height` via `CGDisplayBounds`,
/// which is in Apple's "points" (per-display logical units) -- distinct from
/// the physical pixels `capture_image()` returns (`CGWindowListCreateImage`
/// is Retina-aware and returns native pixel dimensions). This mirrors the
/// Linux geometry/pixel-data mismatch above, just with a different cause.
/// `scale_factor()` (itself derived from `CGDisplayMode`'s pixel width vs.
/// the points width) converts each monitor's own rect to physical pixels.
/// macOS's points space is shared/global across displays (there's no
/// *global* divisor bug like Linux's), so this should hold at multi-monitor
/// boundaries too -- but it is unverified on real Retina/mixed-DPI hardware.
/// The `SizeMismatch` check in `capture_monitor` above is the safety net if
/// the rounding doesn't land pixel-exact.
#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub fn monitors() -> CaptureResult<Vec<MonitorInfo>> {
        let monitors =
            xcap::Monitor::all().map_err(|e| CaptureError::Backend(e.to_string()))?;

        monitors
            .iter()
            .map(|m| {
                let scale = m.scale_factor().unwrap_or(1.0);
                let x = m.x().map_err(|e| CaptureError::Backend(e.to_string()))?;
                let y = m.y().map_err(|e| CaptureError::Backend(e.to_string()))?;
                let w = m.width().map_err(|e| CaptureError::Backend(e.to_string()))?;
                let h = m.height().map_err(|e| CaptureError::Backend(e.to_string()))?;

                Ok(MonitorInfo {
                    id: m.id().map_err(|e| CaptureError::Backend(e.to_string()))?,
                    name: m.name().unwrap_or_default(),
                    rect: PhysRect::new(
                        (x as f32 * scale).round() as i32,
                        (y as f32 * scale).round() as i32,
                        (w as f32 * scale).round() as u32,
                        (h as f32 * scale).round() as u32,
                    ),
                    is_primary: m.is_primary().unwrap_or(false),
                })
            })
            .collect()
    }

    /// Same points-vs-pixels mismatch as `monitors()` above, since window
    /// bounds (`kCGWindowBounds`, read via `CGWindowListCopyWindowInfo`) come
    /// from the same Core Graphics global display space as `CGDisplayBounds`.
    /// Scaled by the window's own `current_monitor()` rather than a single
    /// display's factor, so this stays correct if a window sits on a
    /// non-primary display with a different scale factor in a mixed-DPI
    /// multi-monitor setup.
    pub fn windows() -> CaptureResult<Vec<WindowInfo>> {
        let windows = xcap::Window::all().map_err(|e| CaptureError::Backend(e.to_string()))?;

        let mut out = Vec::new();
        for w in windows {
            let is_minimized = w.is_minimized().unwrap_or(false);
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            if is_minimized || width == 0 || height == 0 {
                continue;
            }
            let scale = w
                .current_monitor()
                .ok()
                .and_then(|m| m.scale_factor().ok())
                .unwrap_or(1.0);

            out.push(WindowInfo {
                id: w.id().map_err(|e| CaptureError::Backend(e.to_string()))?,
                title: w.title().unwrap_or_default(),
                app_name: w.app_name().unwrap_or_default(),
                rect: PhysRect::new(
                    (w.x().unwrap_or(0) as f32 * scale).round() as i32,
                    (w.y().unwrap_or(0) as f32 * scale).round() as i32,
                    (width as f32 * scale).round() as u32,
                    (height as f32 * scale).round() as u32,
                ),
            });
        }
        Ok(out)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod live_tests {
    //! Requires a running X server; run with `cargo test -- --ignored`.
    use super::*;

    #[test]
    #[ignore]
    fn capture_all_monitors_matches_geometry() {
        let capturer = XcapCapturer::new();
        let monitors = capturer.monitors().expect("monitors() failed");
        assert!(!monitors.is_empty(), "expected at least one monitor");

        for m in &monitors {
            println!(
                "monitor id={} name={} rect={:?} primary={}",
                m.id, m.name, m.rect, m.is_primary
            );
            let image = capturer
                .capture_monitor(m.id)
                .unwrap_or_else(|e| panic!("capture_monitor({}) failed: {e}", m.id));
            assert_eq!(
                (image.width(), image.height()),
                (m.rect.w, m.rect.h),
                "captured image size must match reported physical rect for monitor {}",
                m.name
            );
        }
    }
}
