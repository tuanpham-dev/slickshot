//! Putting a *file* on the clipboard, as opposed to its contents.
//!
//! `export.rs` copies images as pixels, which is what a chat window or a
//! document wants. A recording cannot work that way -- there is no "video on
//! the clipboard" that applications agree on -- so what gets copied is a
//! reference to the file, the same thing selecting it in the file manager and
//! pressing Copy produces. Pasting into Finder or Explorer then creates a copy
//! of the MP4, and pasting into Mail or Slack attaches it.
//!
//! Each platform names this differently (`NSPasteboard` file URLs, `CF_HDROP`,
//! `text/uri-list`), so there is a body per platform behind one function.

use std::path::Path;

/// Puts `path` on the system clipboard as a file reference.
pub fn copy_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("that file is no longer there".into());
    }
    platform::copy_file(path)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, CStr, CString};
    use std::path::Path;

    extern "C" {
        fn tas_clipboard_copy_file(path: *const c_char, err_out: *mut *mut c_char) -> bool;
        fn tas_record_free(p: *mut c_char);
    }

    pub fn copy_file(path: &Path) -> Result<(), String> {
        let c = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "that path contains a NUL byte".to_string())?;
        let mut err: *mut c_char = std::ptr::null_mut();
        let ok = unsafe { tas_clipboard_copy_file(c.as_ptr(), &mut err) };
        if !err.is_null() {
            let message = unsafe { CStr::from_ptr(err).to_string_lossy().into_owned() };
            unsafe { tas_record_free(err) };
            return Err(message);
        }
        if !ok {
            return Err("couldn't put that file on the clipboard".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalFree, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::UI::Shell::DROPFILES;

    const CF_HDROP: u32 = 15;

    /// A `CF_HDROP` payload is a `DROPFILES` header followed by the file list:
    /// each path NUL-terminated, and the list itself terminated by one more
    /// NUL. Explorer refuses the whole thing if that double terminator is
    /// missing, which is the classic way to get this silently wrong.
    pub fn copy_file(path: &Path) -> Result<(), String> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0); // terminates this path
        wide.push(0); // terminates the list

        let header = std::mem::size_of::<DROPFILES>();
        let bytes = header + wide.len() * 2;

        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if handle.is_null() {
                return Err("couldn't allocate the clipboard buffer".into());
            }
            let locked = GlobalLock(handle);
            if locked.is_null() {
                GlobalFree(handle);
                return Err("couldn't lock the clipboard buffer".into());
            }

            let drop_files = locked as *mut DROPFILES;
            (*drop_files).pFiles = header as u32;
            (*drop_files).pt.x = 0;
            (*drop_files).pt.y = 0;
            (*drop_files).fNC = 0;
            // Paths are UTF-16, so this must be TRUE or Explorer reads the
            // buffer as ANSI and produces mojibake.
            (*drop_files).fWide = 1;

            std::ptr::copy_nonoverlapping(
                wide.as_ptr(),
                (locked as *mut u8).add(header) as *mut u16,
                wide.len(),
            );
            GlobalUnlock(handle);

            if OpenClipboard(std::ptr::null_mut()) == 0 {
                GlobalFree(handle);
                return Err("couldn't open the clipboard".into());
            }
            EmptyClipboard();
            // On success the clipboard owns the handle; freeing it here would
            // be a double free.
            if SetClipboardData(CF_HDROP, handle as HANDLE).is_null() {
                CloseClipboard();
                GlobalFree(handle);
                return Err("couldn't put that file on the clipboard".into());
            }
            CloseClipboard();
        }
        Ok(())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use std::path::Path;

    /// X11 has no clipboard daemon: the owning client serves the data on
    /// request, so this takes the CLIPBOARD selection on a detached thread and
    /// answers until another client claims it. The same "serve until replaced"
    /// shape `export.rs` relies on `arboard` for with images.
    pub fn copy_file(path: &Path) -> Result<(), String> {
        let uri = format!("file://{}", encode_uri(&path.to_string_lossy()));
        crate::record::clipboard::x11::serve(uri, path.to_string_lossy().into_owned())
    }

    /// Percent-encodes the bytes a `file://` URI may not carry literally.
    /// Spaces are the common case -- an unencoded one truncates the path at
    /// the space in most file managers.
    fn encode_uri(path: &str) -> String {
        let mut out = String::with_capacity(path.len());
        for byte in path.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    out.push(byte as char)
                }
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
        out
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) mod x11 {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, Property,
        SelectionNotifyEvent, SelectionRequestEvent, WindowClass, SELECTION_NOTIFY_EVENT,
    };
    use x11rb::protocol::Event;
    use x11rb::wrapper::ConnectionExt as _;

    /// Serves the CLIPBOARD selection with `uri` until another client takes
    /// it. Returns as soon as ownership is confirmed; the serving continues on
    /// its own thread.
    pub fn serve(uri: String, plain: String) -> Result<(), String> {
        let (conn, screen_num) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let screen = &conn.setup().roots[screen_num];
        let window = conn.generate_id().map_err(|e| e.to_string())?;
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            screen.root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            screen.root_visual,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .map_err(|e| e.to_string())?;

        let atom = |name: &str| -> Result<u32, String> {
            Ok(conn
                .intern_atom(false, name.as_bytes())
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?
                .atom)
        };
        let clipboard = atom("CLIPBOARD")?;
        let targets = atom("TARGETS")?;
        let uri_list = atom("text/uri-list")?;
        let gnome = atom("x-special/gnome-copied-files")?;
        let utf8 = atom("UTF8_STRING")?;

        conn.set_selection_owner(window, clipboard, x11rb::CURRENT_TIME)
            .map_err(|e| e.to_string())?;
        conn.flush().map_err(|e| e.to_string())?;
        let owner = conn
            .get_selection_owner(clipboard)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .owner;
        if owner != window {
            return Err("another application is holding the clipboard".into());
        }

        std::thread::spawn(move || {
            // Nautilus and friends want a verb on the first line; the URI list
            // is the cross-desktop form; UTF8_STRING is the fallback a plain
            // text field will paste.
            let gnome_payload = format!("copy\n{uri}");
            loop {
                let Ok(event) = conn.wait_for_event() else {
                    break;
                };
                match event {
                    Event::SelectionRequest(req) => {
                        let _ = answer(
                            &conn,
                            &req,
                            targets,
                            uri_list,
                            gnome,
                            utf8,
                            &uri,
                            &gnome_payload,
                            &plain,
                        );
                    }
                    // Another client took the clipboard: our data is stale and
                    // this thread has nothing left to serve.
                    Event::SelectionClear(_) => break,
                    _ => {}
                }
            }
        });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn answer<C: Connection>(
        conn: &C,
        req: &SelectionRequestEvent,
        targets: u32,
        uri_list: u32,
        gnome: u32,
        utf8: u32,
        uri: &str,
        gnome_payload: &str,
        plain: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut property = req.property;
        if req.target == targets {
            let list = [targets, uri_list, gnome, utf8];
            conn.change_property32(
                PropMode::REPLACE,
                req.requestor,
                req.property,
                AtomEnum::ATOM,
                &list,
            )?;
        } else if req.target == uri_list {
            // CRLF-terminated, per RFC 2483.
            conn.change_property8(
                PropMode::REPLACE,
                req.requestor,
                req.property,
                req.target,
                format!("{uri}\r\n").as_bytes(),
            )?;
        } else if req.target == gnome {
            conn.change_property8(
                PropMode::REPLACE,
                req.requestor,
                req.property,
                req.target,
                gnome_payload.as_bytes(),
            )?;
        } else if req.target == utf8 || req.target == u32::from(AtomEnum::STRING) {
            conn.change_property8(
                PropMode::REPLACE,
                req.requestor,
                req.property,
                req.target,
                plain.as_bytes(),
            )?;
        } else {
            // Refusing a target is done by replying with property None, not
            // by staying silent -- a requestor left waiting hangs.
            property = 0;
        }

        conn.send_event(
            false,
            req.requestor,
            EventMask::NO_EVENT,
            SelectionNotifyEvent {
                response_type: SELECTION_NOTIFY_EVENT,
                sequence: 0,
                time: req.time,
                requestor: req.requestor,
                selection: req.selection,
                target: req.target,
                property,
            },
        )?;
        conn.flush()?;
        let _ = Property::NEW_VALUE; // keeps the import honest across x11rb versions
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_refused_before_touching_the_clipboard() {
        let err = copy_file(Path::new("/definitely/not/here.mp4")).unwrap_err();
        assert!(
            err.contains("no longer there"),
            "expected a clear message, got {err:?}"
        );
    }
}

/// Live: needs a real pasteboard, so it is `#[ignore]`d like the recording
/// tests. Run with `cargo test copies_a_file_to_the_pasteboard -- --ignored`.
#[cfg(all(test, target_os = "macos"))]
mod live_tests {
    use super::*;

    #[test]
    #[ignore]
    fn copies_a_file_to_the_pasteboard() {
        let path = std::env::temp_dir().join("slickshot-clipboard-test.mp4");
        std::fs::write(&path, b"not really an mp4").expect("write");
        copy_file(&path).expect("copy");

        // Read it back the way a pasting application would.
        let out = std::process::Command::new("osascript")
            .args(["-e", "the clipboard as «class furl»"])
            .output()
            .expect("osascript");
        let text = String::from_utf8_lossy(&out.stdout);
        println!("pasteboard: {}", text.trim());
        assert!(
            out.status.success(),
            "the pasteboard holds no file URL: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let _ = std::fs::remove_file(&path);
    }
}
