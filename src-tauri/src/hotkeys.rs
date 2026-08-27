use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::commands::{run_capture, CaptureMode, Capturer};
use crate::images::ImageStore;
use crate::session::CaptureSession;

/// Serializes every call into the global-shortcut plugin behind one
/// process-wide lock, always from a spawned thread. The plugin's
/// register/unregister marshal onto the main event-loop thread and block
/// the calling thread until that completes; calling it from more than one
/// unsynchronized call site (a settings change racing a transient rebind,
/// for example) can leave two callers waiting on each other and hang the
/// app. See LESSONS.md 2026-08-17.
static HOTKEY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyBinding {
    pub accelerator: String,
    pub mode: CaptureMode,
}

pub fn default_bindings() -> Vec<HotkeyBinding> {
    vec![
        HotkeyBinding {
            accelerator: "PrintScreen".into(),
            mode: CaptureMode::Region,
        },
        HotkeyBinding {
            accelerator: "Shift+PrintScreen".into(),
            mode: CaptureMode::Screen,
        },
        HotkeyBinding {
            accelerator: "Ctrl+PrintScreen".into(),
            mode: CaptureMode::Window,
        },
        HotkeyBinding {
            accelerator: "Ctrl+Shift+PrintScreen".into(),
            mode: CaptureMode::Translate,
        },
        // Unbound by default: these are opt-in conveniences, and picking
        // accelerators for them out of the box risks clashing with whatever
        // the user's desktop already claims. Settings > Shortcuts lists them
        // (via `fill_missing_hotkeys`) ready to be assigned.
        HotkeyBinding {
            accelerator: String::new(),
            mode: CaptureMode::RegionRepeat,
        },
        HotkeyBinding {
            accelerator: String::new(),
            mode: CaptureMode::Color,
        },
        HotkeyBinding {
            accelerator: String::new(),
            mode: CaptureMode::Measure,
        },
    ]
}

/// Re-registers every hotkey binding. Safe to call again after a settings
/// change; always runs on its own spawned thread under `HOTKEY_LOCK`.
pub fn sync(app: &AppHandle, bindings: Vec<HotkeyBinding>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _guard = HOTKEY_LOCK.lock().unwrap();
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();

        for binding in bindings {
            // An empty accelerator means the user cleared this mode's
            // shortcut -- nothing to register, and registering "" would
            // just fail noisily on every sync.
            if binding.accelerator.is_empty() {
                continue;
            }
            let mode = binding.mode;
            let result = gs.on_shortcut(binding.accelerator.as_str(), move |app_handle, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                trigger_capture(app_handle, mode);
            });
            if let Err(e) = result {
                let message = format!("Couldn't register {}: {e}", binding.accelerator);
                eprintln!("[hotkeys] {message}");
                let _ = app.emit("hotkeys:error", message);
            }
        }
    });
}

fn trigger_capture(app: &AppHandle, mode: CaptureMode) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let capturer = app.state::<Capturer>();
        let session = app.state::<Mutex<Option<CaptureSession>>>();
        let images = app.state::<ImageStore>();
        if let Err(e) = run_capture(&app, capturer.inner(), session.inner(), images.inner(), mode, 0, None).await {
            eprintln!("[hotkeys] capture failed: {e}");
        }
    });
}
