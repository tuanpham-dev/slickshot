//! The recording session: what runs between the user confirming a region and
//! the finished MP4 being handed off.
//!
//! Shaped like `scroll.rs`, which is the other capture that keeps running
//! after the overlay comes down: one at a time, a draggable pill for progress
//! and the two ways out, and a guard that tears the state down however the
//! session ends.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{CommandError, CommandResult};
use crate::geometry::PhysRect;
use crate::record::{self, ActiveRecording, RecordConfig};

const LABEL: &str = "record-control";
/// How often the pill's timer is refreshed. Fast enough to read as a running
/// clock, slow enough not to wake the webview constantly.
const TICK: Duration = Duration::from_millis(250);
/// Recordings left behind by a crash are swept at startup once they are older
/// than this -- long enough that a session running across a restart is never
/// deleted out from under itself.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Serialize)]
struct RecordProgress {
    elapsed_ms: u64,
}

/// Overrides a CLI `record` invocation set for the capture it triggered.
/// Taken (not read) when the recording starts, so they cannot leak into
/// whatever the user records next by hand.
#[derive(Default)]
pub struct RecordCliOptions(pub Mutex<Option<CliRecordOptions>>);

#[derive(Debug, Clone, Default)]
pub struct CliRecordOptions {
    pub duration_s: Option<f32>,
    pub system_audio: Option<bool>,
    pub microphone: Option<bool>,
    pub fps: Option<u32>,
}

/// The one recording that may be in flight, and the flag its timer thread
/// watches. `active` holds the platform session; `None` means nothing is
/// running and a new recording may start.
#[derive(Default)]
pub struct RecordSession {
    active: Mutex<Option<Box<dyn ActiveRecording>>>,
    ticking: Arc<AtomicBool>,
}

impl RecordSession {
    pub fn is_running(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }
}

/// Where in-progress recordings live before the user decides what to do with
/// them. Under the app's own data dir rather than the save folder, so a
/// discarded recording never appears among the user's screenshots.
fn recordings_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Image(e.to_string()))?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(dir)
}

/// Deletes recordings a previous run left behind. A crash mid-recording
/// leaves an unfinalized MP4 that nothing else will ever claim, and those are
/// full-size files -- without this they accumulate silently forever.
pub fn sweep_stale(app: &AppHandle) {
    let Ok(dir) = recordings_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|age| age > STALE_AFTER).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Starts recording `rect`.
///
/// The overlays come down first, like scrolling capture: they cover the
/// screen, and a recording of our own dimming is not what anyone asked for.
#[tauri::command]
pub async fn record_start(
    app: AppHandle,
    rect: PhysRect,
    system_audio: bool,
    microphone: bool,
) -> CommandResult<()> {
    if app.state::<RecordSession>().is_running() {
        return Err(CommandError::Capture("a recording is already running".into()));
    }

    let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();
    let cli = app.state::<RecordCliOptions>().0.lock().unwrap().take();

    // A recording is one display's stream, so a region dragged across two
    // monitors has no single source to record -- said plainly here rather
    // than letting the backend fail with something about display ids.
    let monitors = app
        .state::<crate::commands::Capturer>()
        .0
        .monitors()
        .map_err(|e| CommandError::Capture(e.to_string()))?;
    let overlapping: Vec<_> = monitors
        .iter()
        .filter(|m| m.rect.intersect(&rect).is_some())
        .collect();
    let monitor = match overlapping.as_slice() {
        [] => {
            return Err(CommandError::Capture(
                "that region isn't on any monitor".into(),
            ))
        }
        [only] => *only,
        _ => {
            return Err(CommandError::Capture(
                "a recording has to fit on one monitor -- this region spans several".into(),
            ))
        }
    };

    crate::overlay::close_overlays(&app);
    crate::selection::clear_selection(&app);
    // Give the compositor a moment to actually take the overlays down, or the
    // opening frames are a picture of our own dimming.
    tokio::time::sleep(Duration::from_millis(250)).await;

    let out_path = recordings_dir(&app)?.join(format!("{}.mp4", uuid::Uuid::new_v4()));
    let cfg = RecordConfig {
        rect,
        monitor_id: monitor.id,
        fps: cli
            .as_ref()
            .and_then(|c| c.fps)
            .unwrap_or(settings.record_fps),
        show_cursor: settings.record_show_cursor,
        system_audio: cli
            .as_ref()
            .and_then(|c| c.system_audio)
            .unwrap_or(system_audio),
        microphone: cli
            .as_ref()
            .and_then(|c| c.microphone)
            .unwrap_or(microphone),
        out_path,
    };

    let active = record::default_backend()
        .start_recording(&cfg)
        .map_err(|e| CommandError::Capture(e.to_string()))?;

    let warnings = active.warnings();
    *app.state::<RecordSession>().active.lock().unwrap() = Some(active);

    // Built after the recorder starts: a pill on screen with no recording
    // behind it is worse than a beat of delay before it appears. The audio
    // flags ride in the URL so the badges are right on the first paint.
    let route = format!(
        "index.html#record?system={}&mic={}",
        u8::from(cfg.system_audio),
        u8::from(cfg.microphone)
    );
    record::pill::open_pill(&app, LABEL, &route, "Recording", rect)?;
    for warning in warnings {
        let _ = app.emit("record:warning", warning);
    }

    let ticking = app.state::<RecordSession>().ticking.clone();
    ticking.store(true, Ordering::SeqCst);
    let ticker = app.clone();
    std::thread::spawn(move || {
        while ticking.load(Ordering::SeqCst) {
            let elapsed = ticker
                .state::<RecordSession>()
                .active
                .lock()
                .unwrap()
                .as_ref()
                .map(|r| r.elapsed());
            let Some(elapsed) = elapsed else { break };
            let _ = ticker.emit(
                "record:progress",
                RecordProgress {
                    elapsed_ms: elapsed.as_millis() as u64,
                },
            );
            std::thread::sleep(TICK);
        }
    });

    // `--duration` ends the recording without anyone at the keyboard, which
    // is what makes `slickshot record` usable from a script.
    if let Some(seconds) = cli.and_then(|c| c.duration_s).filter(|s| *s > 0.0) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs_f32(seconds)).await;
            if app.state::<RecordSession>().is_running() {
                if let Err(e) = record_stop(app.clone()).await {
                    eprintln!("[record] couldn't stop after --duration: {e}");
                }
            }
        });
    }

    Ok(())
}

/// Ends the recording and keeps the result.
#[tauri::command]
pub async fn record_stop(app: AppHandle) -> CommandResult<()> {
    let session = app.state::<RecordSession>();
    session.ticking.store(false, Ordering::SeqCst);
    let active = session.active.lock().unwrap().take();
    record::pill::close_pill(&app, LABEL);

    let Some(active) = active else {
        return Ok(());
    };
    let path = active.stop().map_err(|e| {
        clear_sink(&app);
        CommandError::Capture(e.to_string())
    })?;

    deliver_recording(&app, path).await
}

/// Ends the recording and throws the result away.
#[tauri::command]
pub fn record_cancel(app: AppHandle) {
    let session = app.state::<RecordSession>();
    session.ticking.store(false, Ordering::SeqCst);
    let active = session.active.lock().unwrap().take();
    record::pill::close_pill(&app, LABEL);
    if let Some(active) = active {
        active.cancel();
    }
    clear_sink(&app);
}

/// Drops a pending `slickshot record -o …` sink. A cancelled or failed
/// recording leaves nothing to write, and a sink left armed would silently
/// divert whatever the user captured next.
fn clear_sink(app: &AppHandle) {
    *app.state::<crate::cli::CliSink>().0.lock().unwrap() = None;
}

/// The single place a finished recording is handed off, so the CLI sink and
/// `post_capture` behave the same way they do for a screenshot.
pub async fn deliver_recording(app: &AppHandle, path: PathBuf) -> CommandResult<()> {
    let settings = crate::settings::get_settings(app.clone()).unwrap_or_default();

    // `slickshot record -o clip.mp4` is waiting for a file, not for a window.
    let sink = app.state::<crate::cli::CliSink>().0.lock().unwrap().take();
    if let Some(output) = sink {
        if let Some(dest) = output.output {
            let dest_is_gif = dest
                .extension()
                .map(|e| e.eq_ignore_ascii_case("gif"))
                .unwrap_or(false);
            if dest_is_gif {
                // Transcoding to GIF is the editor's export path; wiring the
                // CLI into it comes with that work.
                let _ = std::fs::remove_file(&path);
                return Err(CommandError::Capture(
                    "GIF output isn't available from the CLI yet -- record to .mp4".into(),
                ));
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| CommandError::Image(e.to_string()))?;
            }
            move_file(&path, &dest)?;
            crate::export::notify_saved(app, &dest.to_string_lossy());
            record_history(app, &dest);
            println!("{}", dest.display());
            return Ok(());
        }
        // No `-o`: the CLI's default sink is a quicksave, same as a still.
        let dest = crate::export::recording_quicksave_file(&settings);
        move_file(&path, &dest)?;
        crate::export::notify_saved(app, &dest.to_string_lossy());
        record_history(app, &dest);
        println!("{}", dest.display());
        return Ok(());
    }

    let action = app
        .state::<crate::commands::PostCaptureOverride>()
        .0
        .lock()
        .unwrap()
        .take()
        .unwrap_or(settings.post_capture);

    match action {
        // The floating thumbnail shows a still image and its actions act on
        // one; a recording has nothing for it to display, so both "show me
        // it" choices land in the editor instead.
        crate::settings::PostCaptureAction::Editor
        | crate::settings::PostCaptureAction::Thumbnail => {
            crate::video::open_editor(app, &path).await
        }
        crate::settings::PostCaptureAction::None => {
            let auto_save = app
                .state::<crate::commands::AutoSaveOverride>()
                .0
                .lock()
                .unwrap()
                .take()
                .unwrap_or(settings.auto_save);
            if auto_save {
                let dest = crate::export::recording_quicksave_file(&settings);
                move_file(&path, &dest)?;
                crate::export::notify_saved(app, &dest.to_string_lossy());
                record_history(app, &dest);
            } else {
                let _ = std::fs::remove_file(&path);
            }
            Ok(())
        }
    }
}

/// Moves a finished recording into place, falling back to copy+delete when
/// the temp dir and the destination are on different volumes (an external
/// drive as the save folder is the common case).
fn move_file(from: &Path, to: &Path) -> CommandResult<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| CommandError::Image(e.to_string()))?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

fn record_history(app: &AppHandle, saved: &Path) {
    crate::history::record_saved_video(app, saved);
}
