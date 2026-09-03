//! Synthetic pointer input for scrolling capture.
//!
//! Scrolling capture drives the content itself rather than asking the user to
//! scroll, which means putting wheel events into whatever window is under the
//! pointer. Every platform has its own way in, and none of them is reachable
//! from a portable crate we already depend on.
//!
//! Linux is the tested path (XTest, which Xvfb also implements, so the whole
//! capture loop is verifiable headlessly). Windows and macOS compile per
//! target but have not been run.

/// Wheel clicks the first capture tick sends. One, because how far a click
/// scrolls is a property of the application, not something we can know in
/// advance: a browser moves 120 CSS pixels, a document viewer a line, a
/// terminal three. The caller measures the first step and picks the count
/// from there, so the only risk taken blind is a tick that scrolls too
/// little -- which costs a round trip, where too much costs the overlap the
/// match depends on.
pub const INITIAL_WHEEL_STEPS: u32 = 1;
/// Ceiling on that adaptation, so a badly-measured step cannot run away.
pub const MAX_WHEEL_STEPS: u32 = 16;

#[derive(Debug)]
pub struct InputError(pub String);

impl std::fmt::Display for InputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

pub type InputResult<T> = Result<T, InputError>;

#[cfg(target_os = "linux")]
mod platform {
    use super::{InputError, InputResult};
    use x11rb::connection::Connection;
    use x11rb::protocol::xtest::ConnectionExt as _;
    use x11rb::protocol::xproto::ConnectionExt as _;

    /// X11 button 5 is "wheel down"; 4 is up. Each click is a press/release
    /// pair, the same shape a real wheel produces.
    const BUTTON_WHEEL_DOWN: u8 = 5;
    /// X core protocol event codes, as `XTestFakeInput` expects them.
    const XTEST_BUTTON_PRESS: u8 = 4;
    const XTEST_BUTTON_RELEASE: u8 = 5;

    fn connect() -> InputResult<(x11rb::rust_connection::RustConnection, usize)> {
        if std::env::var_os("DISPLAY").is_none() {
            return Err(InputError(
                "scrolling capture needs an X11 display; on Wayland it has no way to scroll the page for you"
                    .into(),
            ));
        }
        x11rb::connect(None).map_err(|e| InputError(format!("couldn't reach the X server: {e}")))
    }

    pub fn warp_pointer(x: i32, y: i32) -> InputResult<()> {
        let (conn, screen_num) = connect()?;
        let root = conn.setup().roots[screen_num].root;
        conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, x as i16, y as i16)
            .map_err(|e| InputError(e.to_string()))?;
        sync(&conn)
    }

    pub fn wheel_down(steps: u32) -> InputResult<()> {
        let (conn, screen_num) = connect()?;
        let root = conn.setup().roots[screen_num].root;
        for _ in 0..steps {
            for event_type in [XTEST_BUTTON_PRESS, XTEST_BUTTON_RELEASE] {
                conn.xtest_fake_input(event_type, BUTTON_WHEEL_DOWN, 0, root, 0, 0, 0)
                    .map_err(|e| InputError(format!("XTest is unavailable: {e}")))?;
            }
            // Each click is delivered before the next is queued: a burst sent
            // in one go is coalesced by some toolkits into a single scroll.
            sync(&conn)?;
        }
        Ok(())
    }

    /// Flushing only queues the request; a round trip is what guarantees the
    /// server has acted on it before this connection goes away.
    fn sync(conn: &x11rb::rust_connection::RustConnection) -> InputResult<()> {
        conn.flush().map_err(|e| InputError(e.to_string()))?;
        conn.get_input_focus()
            .map_err(|e| InputError(e.to_string()))?
            .reply()
            .map_err(|e| InputError(e.to_string()))?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{InputError, InputResult};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };

    /// One notch of a real wheel. Negative scrolls the content down.
    const WHEEL_DELTA: i32 = 120;

    pub fn warp_pointer(x: i32, y: i32) -> InputResult<()> {
        // SAFETY: SetCursorPos takes two ints and reports failure by return
        // value; there are no buffers involved.
        let ok = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y) };
        if ok == 0 {
            return Err(InputError("couldn't move the pointer".into()));
        }
        Ok(())
    }

    pub fn wheel_down(steps: u32) -> InputResult<()> {
        for _ in 0..steps {
            let input = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: (-WHEEL_DELTA) as u32,
                        dwFlags: MOUSEEVENTF_WHEEL,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            };
            // SAFETY: one fully-initialised INPUT is passed with its own size,
            // which is exactly the contract SendInput documents.
            let sent = unsafe {
                SendInput(1, &input, std::mem::size_of::<INPUT>() as i32)
            };
            if sent != 1 {
                return Err(InputError("the system rejected the scroll event".into()));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{InputError, InputResult};
    use core_graphics::event::{CGEvent, CGEventTapLocation, ScrollEventUnit};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;

    fn source() -> InputResult<CGEventSource> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| InputError("couldn't open an event source".into()))
    }

    pub fn warp_pointer(x: i32, y: i32) -> InputResult<()> {
        let event = CGEvent::new_mouse_event(
            source()?,
            core_graphics::event::CGEventType::MouseMoved,
            CGPoint::new(x as f64, y as f64),
            core_graphics::event::CGMouseButton::Left,
        )
        .map_err(|_| InputError("couldn't build a pointer event".into()))?;
        event.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn wheel_down(steps: u32) -> InputResult<()> {
        for _ in 0..steps {
            let event = CGEvent::new_scroll_event(source()?, ScrollEventUnit::LINE, 1, -3, 0, 0)
                .map_err(|_| InputError("couldn't build a scroll event".into()))?;
            event.post(CGEventTapLocation::HID);
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{InputError, InputResult};

    pub fn warp_pointer(_x: i32, _y: i32) -> InputResult<()> {
        Err(InputError("scrolling capture isn't supported on this platform".into()))
    }
    pub fn wheel_down(_steps: u32) -> InputResult<()> {
        Err(InputError("scrolling capture isn't supported on this platform".into()))
    }
}

/// Moves the pointer so wheel events land on the content being captured.
pub fn warp_pointer(x: i32, y: i32) -> InputResult<()> {
    platform::warp_pointer(x, y)
}

/// Scrolls the content under the pointer down by `steps` wheel clicks.
pub fn wheel_down(steps: u32) -> InputResult<()> {
    platform::wheel_down(steps)
}
