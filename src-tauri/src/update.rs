//! Self-updating for the bundles that support it (Windows, macOS, AppImage).
//!
//! Exposed as ordinary app commands rather than through the updater plugin's
//! JavaScript API, matching how the rest of this app talks to its backend
//! (`src/lib/ipc.ts` wraps `invoke` calls, not plugin SDKs) and keeping the
//! frontend free of another dependency.
//!
//! The `.deb`/`.rpm`/AUR packages are updated by the user's package manager;
//! those builds have no updater artifact, so `check_update` reports
//! `supported: false` and the UI says so instead of offering a download.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::{CommandError, CommandResult};

/// The update found by `check_update`, held so `install_update` can apply the
/// same one the user was shown rather than re-resolving it.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    /// False when this build has no updater support (deb/rpm/AUR), so the UI
    /// can point at the package manager instead of showing a dead button.
    pub supported: bool,
    pub current_version: String,
    pub available: Option<AvailableUpdate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Whether this build can update itself in place. Linux only ships an
/// updater artifact for the AppImage; the packaged formats are owned by the
/// system package manager, and letting the app overwrite them would fight it.
fn updater_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("APPIMAGE").is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub current_version: String,
    /// Same meaning as `UpdateStatus::supported`, available without a network
    /// round-trip so the UI can show the running version and gate the
    /// "check automatically" toggle before -- or even without ever -- calling
    /// `check_update`.
    pub supported: bool,
}

/// Local-only counterpart to `check_update`: the running version and whether
/// this build can self-update at all, neither of which needs the release
/// feed. Settings calls this on mount so the version number and the
/// package-manager-vs-updater messaging always show, even when the feed is
/// unreachable (no internet, no release published yet, a firewall) -- a
/// state `check_update` treats as a hard error.
#[tauri::command]
pub fn version_info(app: AppHandle) -> VersionInfo {
    VersionInfo {
        current_version: app.package_info().version.to_string(),
        supported: updater_supported(),
    }
}

#[tauri::command]
pub async fn check_update(app: AppHandle, state: tauri::State<'_, PendingUpdate>) -> CommandResult<UpdateStatus> {
    let current_version = app.package_info().version.to_string();
    if !updater_supported() {
        return Ok(UpdateStatus {
            supported: false,
            current_version,
            available: None,
        });
    }

    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|e| CommandError::Image(format!("couldn't check for updates: {e}")))?;
    let found = updater
        .check()
        .await
        .map_err(|e| CommandError::Image(format!("couldn't check for updates: {e}")))?;

    let available = found.as_ref().map(|u| AvailableUpdate {
        version: u.version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *state.0.lock().unwrap() = found;

    Ok(UpdateStatus {
        supported: true,
        current_version,
        available,
    })
}

/// Downloads and installs the update `check_update` found, then restarts.
/// Does not return on success -- the process is replaced.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: tauri::State<'_, PendingUpdate>) -> CommandResult<()> {
    let update = state
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| CommandError::Image("no update is ready to install".into()))?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| CommandError::Image(format!("couldn't install the update: {e}")))?;

    app.restart();
}

/// Startup check, run well after launch so it never competes with the first
/// capture. Emits `update:available` for the UI to surface; failures are
/// silent because an unreachable release feed is not worth interrupting a
/// screenshot for.
pub fn check_in_background(app: &AppHandle) {
    if !updater_supported() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;

        let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
        if !settings.auto_check_updates {
            return;
        }

        let state = app.state::<PendingUpdate>();
        match check_update(app.clone(), state).await {
            Ok(status) => {
                if let Some(update) = status.available {
                    use tauri::Emitter;
                    let _ = app.emit("update:available", update);
                }
            }
            Err(e) => eprintln!("[update] background check failed: {e}"),
        }
    });
}
