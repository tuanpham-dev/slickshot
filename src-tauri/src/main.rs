// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use slickshot_lib::cli::{self, Cli};

/// Re-attaches stdout/stderr to the launching terminal's console on Windows.
/// `windows_subsystem = "windows"` above (release builds) otherwise leaves
/// the CLI's `println!`/`eprintln!` with nowhere to go -- see the plan's
/// "Windows console attach" decision. `#[cfg(windows)]`-gated so it can't
/// affect any other platform's build.
///
/// `AttachConsole` alone isn't enough: a GUI-subsystem process has no
/// console of its own, so its stdout/stderr/stdin handles are NULL/invalid,
/// and attaching to the parent's console doesn't rebind them -- confirmed
/// live (release build, both PowerShell and cmd.exe): the process exits
/// with the right code, but every `println!`/`eprintln!` silently goes
/// nowhere. Reopening `CONOUT$`/`CONIN$` and rebinding via `SetStdHandle`
/// fixes it; Rust's stdio fetches the handle fresh on each write rather
/// than caching it at startup, so this only has to happen before `main`'s
/// first print.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        AttachConsole, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
        STD_OUTPUT_HANDLE,
    };

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }

        // Unconditional, not just when the existing handle is NULL/invalid:
        // a std handle that was inherited pre-redirected to something other
        // than a console (e.g. a pipe an automation harness set up to
        // capture this process's output) is already "valid" by that check
        // but still isn't the console this just attached to. Reopening
        // CONOUT$/CONIN$ always resolves to whatever console is current,
        // so it's correct to do this every time attach succeeds.
        let reopen = |name: &str, access: u32, share: u32, std_handle: u32| {
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            let handle = CreateFileW(wide.as_ptr(), access, share, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
            if handle != INVALID_HANDLE_VALUE {
                SetStdHandle(std_handle, handle);
            }
        };

        reopen("CONOUT$", FILE_GENERIC_WRITE, FILE_SHARE_WRITE, STD_OUTPUT_HANDLE);
        reopen("CONOUT$", FILE_GENERIC_WRITE, FILE_SHARE_WRITE, STD_ERROR_HANDLE);
        reopen("CONIN$", FILE_GENERIC_READ, FILE_SHARE_READ, STD_INPUT_HANDLE);
    }
}

fn main() {
    #[cfg(windows)]
    attach_console();

    let cli = Cli::parse();

    match cli.command {
        None => slickshot_lib::run(None),
        Some(cmd) if cmd.is_headless() => match cli::run_headless(cmd) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        },
        Some(cmd) => {
            if let Err(e) = cli::validate_interactive(&cmd) {
                eprintln!("error: {e}");
                std::process::exit(2);
            }
            cli::sleep_for_delay(&cmd);
            slickshot_lib::run(Some(cmd));
        }
    }
}
