//! The small always-on-top control window that a long-running capture puts on
//! screen -- scrolling capture's progress pill and recording's timer both use
//! it. Shared so the two cannot drift in placement, sizing or the DPI
//! handling, which is the fiddly part.

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::commands::{CommandError, CommandResult};
use crate::geometry::PhysRect;

/// The pill's size in logical (CSS) pixels, scaled by the monitor's DPI
/// factor before it is placed.
pub const PILL_W: i32 = 260;
pub const PILL_H: i32 = 64;
const GAP_LOGICAL: i32 = 12;

#[cfg(target_os = "macos")]
extern "C" {
    fn tas_window_exclude_from_capture(ns_window: *mut std::ffi::c_void);
}

/// Keeps the pill out of screen captures, including the recording it is
/// reporting on.
///
/// It has to sit above what is being recorded, and a region that fills the
/// screen leaves nowhere outside to put it. Scrolling capture hides it for
/// each grab; a continuous recording cannot. On macOS the window is simply
/// marked unshareable. Windows and Linux have no equivalent that reaches
/// `xcap`'s whole-monitor grab, so the pill is still captured there -- noted
/// in the platform hand-off.
fn exclude_from_capture(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        // On the main thread, always. `record_start` is an async command, so
        // this runs on a tokio worker by default -- and touching an NSWindow
        // from there trapped inside AppKit's window manager and took the whole
        // app down with it.
        let window = window.clone();
        let _ = window.clone().run_on_main_thread(move || {
            if let Ok(ns_window) = window.ns_window() {
                unsafe { tas_window_exclude_from_capture(ns_window) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Builds and shows a pill window for `label`, anchored to `rect`.
pub fn open_pill(
    app: &AppHandle,
    label: &str,
    route: &str,
    title: &str,
    rect: PhysRect,
) -> CommandResult<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
        .title(title)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Resizable, then pinned by an equal min and max size: GTK sizes a
        // *non*-resizable window to its content's natural request and ignores
        // the size asked for, which left the pill several times taller than
        // it needed to be, with empty space above and below the controls.
        .resizable(true)
        .visible(false)
        .build()
        .map_err(|e| CommandError::Window(e.to_string()))?;

    // The *position* is physical, like the overlays'. `WebviewWindowBuilder::
    // position` takes logical pixels and scales them by the DPI factor, so
    // handing it the physical geometry we work in everywhere else lands the
    // pill at twice the intended offset -- off-screen on a HiDPI monitor.
    let scale = window.scale_factor().unwrap_or(1.0);
    let wanted = PhysicalSize::new(
        (PILL_W as f64 * scale).round() as u32,
        (PILL_H as f64 * scale).round() as u32,
    );
    // Placed away from the region where there is room, and in its top-right
    // corner when the region fills the screen. Draggable either way, so it
    // can always be moved off whatever it covers.
    //
    // Placed twice: `outer_size` reads back zero until the window has been
    // realised, so the first placement goes on the size we asked for and the
    // second corrects it against the size the toolkit actually gave us --
    // which is what keeps the pill anchored to the region's corner rather
    // than hanging off it.
    let _ = window.set_size(Size::Physical(wanted));
    let _ = window.set_min_size(Some(Size::Physical(wanted)));
    let _ = window.set_max_size(Some(Size::Physical(wanted)));
    let _ = window.set_position(Position::Physical(control_position(app, rect, wanted)));
    // Before it is shown, so it is never composited into a frame.
    exclude_from_capture(&window);
    let _ = window.show();
    // Placed again against the size the toolkit actually gave us: `set_size`
    // is a request, and a window left larger than asked for would hang off
    // the corner it is supposed to be tucked into.
    if let Ok(actual) = window.outer_size() {
        if actual.width > 0 && actual.height > 0 && actual != wanted {
            let _ = window.set_position(Position::Physical(control_position(app, rect, actual)));
        }
    }

    Ok(window)
}

pub fn close_pill(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}

/// The pill's on-screen bounds, or `None` if it is already hidden or its
/// geometry cannot be read.
pub fn pill_rect(window: &WebviewWindow) -> Option<PhysRect> {
    if !window.is_visible().unwrap_or(false) {
        return None;
    }
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(PhysRect::new(pos.x, pos.y, size.width, size.height))
}

/// Top-left for the control window, plus whether that spot lands inside the
/// captured region. Below the region when there is room, else above it, else
/// tucked into the region's top-right corner -- which does overlap, and the
/// caller hides the pill for each grab in that case.
pub fn control_position(
    app: &AppHandle,
    rect: PhysRect,
    size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let screen = app
        .state::<crate::commands::Capturer>()
        .0
        .monitors()
        .ok()
        .and_then(|ms| ms.into_iter().find(|m| m.rect.intersect(&rect).is_some()))
        .map(|m| m.rect)
        .unwrap_or(rect);
    place_control(rect, screen, size)
}

/// Where the pill goes, in physical pixels. Split out from the monitor lookup
/// so the corner cases are testable without a screen.
pub fn place_control(
    rect: PhysRect,
    screen: PhysRect,
    size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let gap = (GAP_LOGICAL * size.height as i32 / PILL_H).max(1);
    let (w, h) = (size.width as i32, size.height as i32);
    let below = rect.y + rect.h as i32 + gap;
    let above = rect.y - h - gap;
    // Right-aligned with the region, but never past either edge of the
    // monitor -- a region hard against the left edge would otherwise push the
    // pill off it.
    let x = (rect.x + rect.w as i32 - w)
        .min(screen.x + screen.w as i32 - w)
        .max(screen.x);
    let y = if below + h <= screen.y + screen.h as i32 {
        below
    } else if above >= screen.y {
        above
    } else {
        // No room either side: tucked inside the region's top-right corner,
        // which `without_pill` then hides for each grab.
        (rect.y + gap).min(screen.y + screen.h as i32 - h).max(screen.y)
    };
    PhysicalPosition::new(x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: PhysRect = PhysRect { x: 0, y: 0, w: 1920, h: 1080 };

    fn size(scale: u32) -> PhysicalSize<u32> {
        PhysicalSize::new(PILL_W as u32 * scale, PILL_H as u32 * scale)
    }

    #[test]
    fn the_pill_sits_below_the_region_when_there_is_room() {
        let at = place_control(PhysRect::new(200, 100, 800, 400), SCREEN, size(1));
        assert_eq!(at.y, 512, "12px below the region's bottom");
        assert_eq!(at.x, 1000 - PILL_W, "right-aligned with the region");
    }

    #[test]
    fn the_pill_moves_above_a_region_that_reaches_the_bottom() {
        let at = place_control(PhysRect::new(200, 100, 800, 970), SCREEN, size(1));
        assert_eq!(at.y, 100 - PILL_H - 12);
    }

    #[test]
    fn a_full_height_region_keeps_the_pill_on_screen() {
        let at = place_control(PhysRect::new(0, 0, 1920, 1080), SCREEN, size(1));
        assert!(at.y >= 0 && at.y + PILL_H <= 1080, "y={} is off-screen", at.y);
        assert!(at.x >= 0 && at.x + PILL_W <= 1920, "x={} is off-screen", at.x);
    }

    /// The size is in physical pixels, so a 2x monitor gets a 2x pill -- and
    /// the gap has to scale with it or the pill overlaps the region.
    #[test]
    fn placement_scales_with_the_monitor() {
        let at = place_control(PhysRect::new(200, 100, 800, 400), SCREEN, size(2));
        assert_eq!(at.y, 500 + 24);
        assert_eq!(at.x, 1000 - PILL_W * 2);
    }

    /// A region hard against the left edge is narrower than the pill, so
    /// right-aligning it would hang the pill off the monitor.
    #[test]
    fn a_narrow_region_at_the_left_edge_does_not_push_the_pill_off() {
        let at = place_control(PhysRect::new(0, 100, 80, 400), SCREEN, size(1));
        assert_eq!(at.x, 0);
    }
}
