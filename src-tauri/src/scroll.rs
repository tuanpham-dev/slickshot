use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use image::RgbaImage;
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::capture::input::{self, INITIAL_WHEEL_STEPS, MAX_WHEEL_STEPS};
use crate::capture::stitch::{Mask, Push, Stitcher};
use crate::commands::{CommandError, CommandResult};
use crate::geometry::PhysRect;

const LABEL: &str = "scroll-control";
/// The pill's size in logical (CSS) pixels, scaled by the monitor's DPI
/// factor before it is placed.
const PILL_W: i32 = 260;
const PILL_H: i32 = 64;
const GAP_LOGICAL: i32 = 12;
/// How long a new capture waits for a previous one to finish winding down
/// before it gives up and says so.
const START_GRACE: Duration = Duration::from_millis(2_500);
/// Ceiling on the stitched result's height, and on its total pixels. Real
/// pages -- a deals listing, a long thread -- run tens of thousands of pixels
/// deep, so the height alone has to be generous; the pixel budget is what
/// actually keeps a wide region from eating memory unbounded. 64M pixels is
/// 256MB of canvas.
const MAX_HEIGHT: u32 = 50_000;
const MAX_PIXELS: u32 = 64_000_000;
/// How long to wait for the content to stop moving after a scroll before
/// giving up and stitching whatever is on screen. Animated pages never fully
/// settle, so this is a bound rather than a guarantee.
const SETTLE_TIMEOUT: Duration = Duration::from_millis(600);
const SETTLE_INTERVAL: Duration = Duration::from_millis(60);
/// How long to wait for a wheel event to actually move the content. The
/// toolkit repaints on its own schedule, so a grab taken immediately after
/// scrolling still shows the old frame.
const CHANGE_TIMEOUT: Duration = Duration::from_millis(900);
/// How much of the region each tick aims to scroll. The rest is the overlap
/// the matcher works from, and it has to be big enough to survive whatever
/// sticky furniture sits at the top of the region.
const STEP_FRACTION: f32 = 0.6;
/// The most of a region a motion mask may cover before it is thrown away.
/// Past this it is not describing an animation any more, and matching on
/// what little it leaves is worse than matching on everything.
const MAX_MASK_FRACTION: f32 = 0.5;
/// Consecutive ticks that move the content nowhere before the page is called
/// finished. Two rather than one, so a single dropped wheel event doesn't end
/// it early.
const MAX_UNCHANGED: u32 = 2;
/// Consecutive frames that moved but could not be aligned before the capture
/// gives up. A frame that changed is *not* evidence the page ended -- an ad
/// reflowing, a lazy-loaded image arriving, a sticky bar animating can all
/// break one frame's alignment -- so these are retried from a fresh grab
/// rather than ending the capture, which is what used to stop a long page
/// half way down.
const MAX_STITCH_FAILURES: u32 = 4;

#[derive(Clone, Serialize)]
struct ScrollProgress {
    height: u32,
    frames: u32,
}

/// Live scrolling capture. `stop` ends the loop and keeps the result;
/// `cancel` ends it and throws the result away.
#[derive(Default)]
pub struct ScrollSession {
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    running: Arc<Mutex<bool>>,
}

/// Hides the control pill while `body` runs, when the pill would otherwise
/// appear inside the captured pixels.
///
/// A root-window grab has no way to exclude one of our own windows, so the
/// only way to keep the pill out of the screenshot is for it not to be on
/// screen while the frame is taken. Done once per tick rather than per grab,
/// so it reads as a blink rather than a strobe.
fn without_pill<T>(app: &AppHandle, rect: PhysRect, body: impl FnOnce() -> T) -> T {
    // Checked live rather than once at the start: the pill is draggable, so
    // the user can move it onto the region part-way through a capture.
    let pill = app.get_webview_window(LABEL).filter(|w| pill_rect(w).is_some_and(|p| p.intersect(&rect).is_some()));
    if let Some(w) = &pill {
        let _ = w.hide();
        // Let the compositor actually take it down before the grab.
        std::thread::sleep(Duration::from_millis(40));
    }
    let out = body();
    if let Some(w) = &pill {
        let _ = w.show();
    }
    out
}

/// The pill's on-screen bounds, or `None` if it is already hidden or its
/// geometry cannot be read.
fn pill_rect(window: &tauri::WebviewWindow) -> Option<PhysRect> {
    if !window.is_visible().unwrap_or(false) {
        return None;
    }
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(PhysRect::new(pos.x, pos.y, size.width, size.height))
}

/// Grabs the monitor holding `rect` and crops to it. Re-grabbed every tick,
/// which is what makes this a live capture rather than a frozen one.
fn grab_region(app: &AppHandle, rect: PhysRect) -> CommandResult<RgbaImage> {
    let capturer = app.state::<crate::commands::Capturer>();
    let monitors = capturer
        .0
        .monitors()
        .map_err(|e| CommandError::Capture(e.to_string()))?;
    let monitor = monitors
        .iter()
        .find(|m| m.rect.intersect(&rect).is_some())
        .ok_or_else(|| CommandError::Capture("the region isn't on any monitor".into()))?;
    let full = capturer
        .0
        .capture_monitor(monitor.id)
        .map_err(|e| CommandError::Capture(e.to_string()))?;
    let x = (rect.x - monitor.rect.x).max(0) as u32;
    let y = (rect.y - monitor.rect.y).max(0) as u32;
    let w = rect.w.min(full.width().saturating_sub(x));
    let h = rect.h.min(full.height().saturating_sub(y));
    if w == 0 || h == 0 {
        return Err(CommandError::Capture("the region is off-screen".into()));
    }
    Ok(image::imageops::crop_imm(&full, x, y, w, h).to_image())
}

/// Waits for the scroll to land and the region to stop moving, and reports
/// which pixels never stopped.
///
/// Two phases, because a grab taken the instant after a wheel event usually
/// still shows the *old* content: the toolkit has been told to scroll but has
/// not repainted yet. Phase one waits for the frame to differ from
/// `baseline`; without it every frame comes back looking unscrolled and the
/// capture ends immediately. Phase two then waits for it to hold still.
///
/// Both phases are bounded: a page at its end never differs (which is how the
/// capture knows to stop) and an animated one never holds still.
/// Owns the "a capture is in progress" state, and tears it down however the
/// capture ends -- returning, failing, or panicking. A panic in the capture
/// thread used to leave the flag set and the pill on screen for good: the
/// user saw a control that said "Scrolling..." and never moved, and every
/// later capture was refused.
struct SessionGuard {
    running: Arc<Mutex<bool>>,
    app: AppHandle,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        *self.running.lock().unwrap() = false;
        close_control(&self.app);
    }
}

/// What one tick of `settle` came back with.
struct Settled {
    frame: RgbaImage,
    /// Pixels that never stopped changing, and so must not be matched on.
    mask: Option<Mask>,
    /// Whether the region differed from the baseline at all. `false` is the
    /// end-of-page signal, and the only one: a frame that *did* move but
    /// would not align is a stitching failure, not the bottom of the page.
    moved: bool,
}

fn settle(
    app: &AppHandle,
    rect: PhysRect,
    baseline: Option<&RgbaImage>,
    cancel: &AtomicBool,
) -> CommandResult<Settled> {
    let mut current = grab_region(app, rect)?;

    if let Some(baseline) = baseline {
        let deadline = Instant::now() + CHANGE_TIMEOUT;
        while current.dimensions() == baseline.dimensions() && current == *baseline {
            // Both waits below can run for the best part of a second, and a
            // capture that looks stuck is exactly when the user reaches for
            // Cancel -- so they check it rather than making them wait out the
            // timeout.
            if cancel.load(Ordering::SeqCst) {
                return Ok(Settled { frame: current, mask: None, moved: false });
            }
            if Instant::now() >= deadline {
                // Never moved: the page is at its end, or does not scroll.
                return Ok(Settled { frame: current, mask: None, moved: false });
            }
            std::thread::sleep(SETTLE_INTERVAL);
            current = grab_region(app, rect)?;
        }
    }

    let deadline = Instant::now() + SETTLE_TIMEOUT;
    let mut moving: Option<Vec<bool>> = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(Settled { frame: current, mask: None, moved: false });
        }
        std::thread::sleep(SETTLE_INTERVAL);
        let next = grab_region(app, rect)?;
        if next.dimensions() != current.dimensions() {
            current = next;
            continue;
        }
        let mut changed = false;
        let (mw, mh) = next.dimensions();
        let mut frame_mask = vec![false; (mw * mh) as usize];
        for y in 0..next.height() {
            for x in 0..next.width() {
                if next.get_pixel(x, y) != current.get_pixel(x, y) {
                    frame_mask[(y * next.width() + x) as usize] = true;
                    changed = true;
                }
            }
        }
        current = next;
        if !changed {
            // Held still, so nothing is animating and there is nothing to
            // mask. Emphatically *not* the motion accumulated on the way
            // here: a browser scrolls smoothly, so the first samples after a
            // wheel event catch the tail of the scroll itself. Keeping those
            // masks off the content that just moved -- which is all of it --
            // and leaves the matcher looking at the page's static furniture,
            // which lines up at offset zero. Every tick then reports the view
            // as unmoved and the capture stops a screenful in.
            return Ok(Settled { mask: None, frame: current, moved: true });
        }
        moving = Some(match moving {
            Some(prev) => prev.iter().zip(&frame_mask).map(|(a, b)| *a || *b).collect(),
            None => frame_mask,
        });
        if Instant::now() >= deadline {
            // Never held still: something on the page really is animating.
            // The mask is the accumulated motion -- but only if it describes
            // a *part* of the region. One covering most of it is measuring
            // the scroll, not an animation, and matching with nothing left to
            // match on is worse than matching with no mask at all.
            //
            // The frame's own dimensions, not the region's: `grab_region`
            // clamps to the monitor, so a region running past an edge comes
            // back smaller than it was asked for and a mask sized from the
            // region would index past its own data.
            let ignored = moving.unwrap_or_default();
            let covered = ignored.iter().filter(|i| **i).count();
            let mask = (covered as f32) < MAX_MASK_FRACTION * ignored.len() as f32;
            return Ok(Settled {
                frame: current,
                mask: mask.then(|| Mask { width: mw, height: mh, ignored }),
                moved: true,
            });
        }
    }
}

fn close_control(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

/// Starts a scrolling capture over `rect`.
///
/// The overlays come down first: they cover the screen, so leaving them up
/// would feed our own synthetic wheel events straight back into our own
/// window instead of the content being captured.
#[tauri::command]
pub async fn scroll_start(app: AppHandle, rect: PhysRect) -> CommandResult<()> {
    let session = app.state::<ScrollSession>();
    // A capture that was just cancelled takes a moment to wind down, and the
    // natural thing to do after cancelling one is to start another straight
    // away. Refusing that race is what made the confirm look like it had been
    // ignored -- the overlay simply reappeared at the picker.
    let deadline = Instant::now() + START_GRACE;
    while *session.running.lock().unwrap() {
        if Instant::now() >= deadline {
            return Err(CommandError::Capture(
                "a scrolling capture is still running".into(),
            ));
        }
        tokio::time::sleep(SETTLE_INTERVAL).await;
    }
    session.stop.store(false, Ordering::SeqCst);
    session.cancel.store(false, Ordering::SeqCst);
    *session.running.lock().unwrap() = true;
    let stop = session.stop.clone();
    let cancel = session.cancel.clone();
    // Clears the running flag however this function leaves -- including the
    // `?` returns below. Without it a failure to build the control window or
    // move the pointer left the session marked as running for good, and every
    // later scrolling capture was refused as "already running": the overlay
    // stayed up and the confirm looked like it had simply been ignored.
    let guard = SessionGuard { running: session.running.clone(), app: app.clone() };

    crate::overlay::close_overlays(&app);
    crate::selection::clear_selection(&app);
    // Give the compositor a moment to actually take the overlays down before
    // the first grab, or the first frame is a picture of our own dimming.
    tokio::time::sleep(Duration::from_millis(250)).await;

    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#scroll".into()))
        .title("Scrolling capture")
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
    let _ = window.set_position(Position::Physical(control_position(&app, rect, wanted)));
    let _ = window.show();
    // Placed again against the size the toolkit actually gave us: `set_size`
    // is a request, and a window left larger than asked for would hang off
    // the corner it is supposed to be tucked into.
    if let Ok(actual) = window.outer_size() {
        if actual.width > 0 && actual.height > 0 && actual != wanted {
            let _ = window.set_position(Position::Physical(control_position(&app, rect, actual)));
        }
    }

    // The pointer has to sit inside the region for wheel events to reach the
    // content, and clear of the control window.
    input::warp_pointer(rect.x + rect.w as i32 / 2, rect.y + rect.h as i32 / 2)
        .map_err(|e| CommandError::Capture(e.to_string()))?;

    let app_handle = app.clone();
    std::thread::spawn(move || {
        // Moved in, so the flag is cleared and the pill closed when this
        // thread ends -- including by panic, which unwinds through here.
        let guard = guard;
        // A panic in the stitcher is a bug, but it must not present as a
        // capture that runs forever: it becomes an error the user is told
        // about, like any other failure.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_loop(&app_handle, rect, &stop, &cancel)
        }))
        .unwrap_or_else(|_| {
            Err(CommandError::Capture(
                "the scrolling capture stopped on an internal error".into(),
            ))
        });
        drop(guard);
        match outcome {
            Ok(Some(image)) => {
                // `slickshot scroll -o shot.png` is waiting for a file, not
                // for the editor to open. The interactive confirm path takes
                // this sink in `selection::finish_confirm`, which scrolling
                // captures never reach -- they end here instead.
                let sink = app_handle
                    .state::<crate::cli::CliSink>()
                    .0
                    .lock()
                    .unwrap()
                    .take();
                if let Some(output) = sink {
                    let settings =
                        crate::settings::get_settings(app_handle.clone()).unwrap_or_default();
                    if let Err(e) =
                        crate::cli::export_to_sink(&app_handle, image, &output, &settings)
                    {
                        eprintln!("[scroll] couldn't export the capture: {e}");
                    }
                } else {
                    let image_id = app_handle.state::<crate::images::ImageStore>().insert(image);
                    let delivered = tauri::async_runtime::block_on(
                        crate::commands::deliver_capture(&app_handle, image_id, rect),
                    );
                    if let Err(e) = delivered {
                        eprintln!("[scroll] couldn't deliver the capture: {e}");
                    }
                }
            }
            Ok(None) => clear_sink(&app_handle),
            Err(e) => {
                clear_sink(&app_handle);
                eprintln!("[scroll] capture failed: {e}");
                let _ = app_handle.emit("scroll:error", e.to_string());
                crate::export::notify_failed(&app_handle, "Scrolling capture failed", &e.to_string());
            }
        }
    });
    Ok(())
}

/// Drops a pending `slickshot scroll -o …` sink. A cancelled or failed
/// scrolling capture leaves nothing to write, and a sink left armed would
/// silently divert whatever the user captured next.
fn clear_sink(app: &AppHandle) {
    *app.state::<crate::cli::CliSink>().0.lock().unwrap() = None;
}

/// Top-left for the control window, plus whether that spot lands inside the
/// captured region. Below the region when there is room, else above it, else
/// tucked into the region's top-right corner -- which does overlap, and the
/// caller hides the pill for each grab in that case.
fn control_position(app: &AppHandle, rect: PhysRect, size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
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
fn place_control(rect: PhysRect, screen: PhysRect, size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
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

fn run_loop(
    app: &AppHandle,
    rect: PhysRect,
    stop: &AtomicBool,
    cancel: &AtomicBool,
) -> CommandResult<Option<RgbaImage>> {
    let first = without_pill(app, rect, || settle(app, rect, None, cancel))?.frame;
    // Height and pixels both bounded: a narrow column can run very deep, a
    // full-width region cannot be allowed to.
    let cap = MAX_HEIGHT.min(MAX_PIXELS / first.width().max(1));
    let mut stitcher = Stitcher::new(first, cap);
    let mut frames = 1u32;
    let mut unchanged = 0u32;
    let mut failures = 0u32;
    // Reported at the end: without it a capture that stops early is
    // indistinguishable from one that reached the bottom.
    let mut reason = "the user";
    // Set after a frame that would not align: the next pass re-grabs where it
    // is instead of scrolling on, so whatever broke the alignment -- an image
    // arriving, a bar finishing its animation -- gets a chance to settle
    // rather than the capture skipping past it.
    let mut retry = false;
    // How far to scroll each tick, adapted as we learn how far a wheel click
    // actually moves this application's content.
    let mut clicks = INITIAL_WHEEL_STEPS;
    let mut per_click: Option<f32> = None;

    let _ = app.emit(
        "scroll:progress",
        ScrollProgress { height: stitcher.height(), frames },
    );

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }

        if !retry {
            input::wheel_down(clicks).map_err(|e| CommandError::Capture(e.to_string()))?;
        }
        // Tell the stitcher how far this tick should have moved the page, so
        // a sparse overlap has something to fall back on.
        stitcher.expect(per_click.map(|p| (p * clicks as f32).round() as u32).filter(|_| !retry));
        let previous = stitcher.last_frame().clone();
        let settled = without_pill(app, rect, || settle(app, rect, Some(&previous), cancel))?;

        if cancel.load(Ordering::SeqCst) {
            return Ok(None);
        }
        // Nothing moved at all: the page is at its bottom, or does not
        // scroll. The only signal that ends the capture on its own.
        if !settled.moved {
            unchanged += 1;
            if unchanged >= MAX_UNCHANGED {
                reason = "the page not moving (bottom reached, or it does not scroll)";
                break;
            }
            retry = false;
            continue;
        }
        unchanged = 0;

        match stitcher.push(settled.frame, settled.mask.as_ref()) {
            Push::Appended(n) | Push::Ambiguous(n) => {
                failures = 0;
                retry = false;
                frames += 1;
                // Aim each tick at a step that leaves a healthy overlap to
                // match on. Too large a step is not merely wasteful: it can
                // leave a sliver that a sticky bar or a page header fills
                // entirely, and then nothing lines up at all.
                if n > 0 {
                    let measured = n as f32 / clicks.max(1) as f32;
                    let px = per_click.map_or(measured, |p| (p + measured) / 2.0);
                    per_click = Some(px);
                    let target = stitcher.frame_height() as f32 * STEP_FRACTION;
                    clicks = (target / px.max(1.0)).round().clamp(1.0, MAX_WHEEL_STEPS as f32) as u32;
                }
            }
            // The view is where it was: the wheel event went nowhere.
            Push::Duplicate => {
                unchanged += 1;
                retry = false;
                if unchanged >= MAX_UNCHANGED {
                    reason = "the view not moving between frames";
                    break;
                }
            }
            // It moved, but not in a way that could be aligned. Hold position
            // and look again before giving up on the rest of the page.
            Push::NoMatch => {
                failures += 1;
                if failures >= MAX_STITCH_FAILURES {
                    reason = "frames that moved but could not be aligned";
                    break;
                }
                // Back off as well as retrying: the most likely reason a
                // frame will not align is that the tick out-scrolled the
                // overlap, and repeating the same step would fail the same
                // way.
                clicks = (clicks / 2).max(1);
                retry = true;
            }
            Push::HeightCapped => {
                reason = "the height limit, with more page below";
                break;
            }
        }
        let _ = app.emit(
            "scroll:progress",
            ScrollProgress { height: stitcher.height(), frames },
        );
    }

    eprintln!(
        "[scroll] finished: {frames} frames, {}px, ended by {}",
        stitcher.height(),
        reason
    );
    Ok(Some(stitcher.finish()))
}

#[tauri::command]
pub fn scroll_stop(app: AppHandle) {
    app.state::<ScrollSession>().stop.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn scroll_cancel(app: AppHandle) {
    let session = app.state::<ScrollSession>();
    session.cancel.store(true, Ordering::SeqCst);
    session.stop.store(true, Ordering::SeqCst);
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
