use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Window};

/// Labels of webview windows whose frontend has registered its Tauri event
/// listener and signalled it's ready to receive frames. A prewarmed window's
/// page loads asynchronously -- WebView2 needs the OS message loop pumping
/// to finish its (COM-based) initialization -- so emitting a frame event
/// before the frontend's `listen()` call has actually registered means the
/// event is dropped with nothing to catch it, and the window (which only
/// shows itself once its `*_ready` command fires) stays hidden forever.
/// This is most visible cold-starting the whole app from the CLI on
/// Windows, where a capture can otherwise be dispatched before the event
/// loop has pumped even once.
#[derive(Default)]
pub struct MountedWindows(Mutex<HashSet<String>>);

#[tauri::command]
pub fn frontend_mounted(window: Window, mounted: tauri::State<MountedWindows>) {
    mounted.0.lock().unwrap().insert(window.label().to_string());
}

/// Polls until `label`'s frontend has called `frontend_mounted`, or `timeout`
/// elapses. Proceeding after a timeout risks the pre-fix race rather than
/// hanging a capture forever if a window's page load is unexpectedly slow.
pub async fn wait_for_mount(app: &AppHandle, label: &str, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if app.state::<MountedWindows>().0.lock().unwrap().contains(label) {
            return;
        }
        if std::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}
