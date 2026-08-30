pub mod cli;
mod capture;
mod commands;
mod drive;
mod editor;
mod export;
mod face;
mod geometry;
mod hotkeys;
mod images;
mod ocr;
mod overlay;
mod pin;
mod qr;
mod ready;
mod selection;
mod session;
mod settings;
mod theme;
mod thumbnail;
mod tray;
mod update;
mod translate;
mod upload;

use std::sync::{Mutex, OnceLock};

use clap::Parser;
use tauri::Manager;

use commands::{AutoSaveOverride, Capturer, MainWasVisible, PostCaptureOverride, QuicksaveSink};
use editor::EditorImage;
use export::PendingExport;
use images::ImageStore;
use overlay::{OverlayFocus, OverlayImages};
use selection::SelectionState;
use session::CaptureSession;

/// Process-wide handle, for the few paths that need app state but are called
/// from a signature that can't carry one -- notably the upload providers,
/// which are plain functions dispatched from `upload_core`.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub(crate) fn app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE.get().cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli_command: Option<cli::CliCommand>) {
    let builder = tauri::Builder::default()
        // Must be registered before other plugins (Tauri requirement): when
        // another instance is already running, this intercepts during
        // `.run()` below, forwards this process's argv to it via
        // `dispatch`, and this process exits before `setup` ever runs.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match cli::Cli::try_parse_from(argv) {
                Ok(cli::Cli { command: Some(cmd) }) => cli::dispatch(app.clone(), cmd),
                Ok(cli::Cli { command: None }) => {
                    let _ = commands::show_main_window(app.clone());
                }
                Err(e) => eprintln!("[cli] couldn't parse forwarded arguments: {e}"),
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Capturer(capture::default_capturer()))
        .manage(Mutex::new(None::<CaptureSession>))
        .manage(ImageStore::default())
        .manage(OverlayImages::default())
        .manage(OverlayFocus::default())
        .manage(SelectionState::default())
        .manage(EditorImage::default())
        .manage(MainWasVisible::default())
        .manage(PendingExport::default())
        .manage(pin::PinWindows::default())
        .manage(cli::CliSink::default())
        .manage(QuicksaveSink::default())
        .manage(PostCaptureOverride::default())
        .manage(AutoSaveOverride::default())
        .manage(thumbnail::ThumbnailImage::default())
        .manage(update::PendingUpdate::default())
        .manage(ready::MountedWindows::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_monitors,
            commands::list_windows,
            commands::start_capture,
            commands::open_image_file,
            commands::load_image_file,
            commands::read_clipboard_image,
            commands::release_image,
            commands::open_editor,
            commands::show_main_window,
            commands::cursor_physical_position,
            thumbnail::thumbnail_ready,
            thumbnail::thumbnail_close,
            thumbnail::thumbnail_action,
            editor::editor_hide,
            editor::editor_ready,
            overlay::overlay_ready,
            selection::selection_begin,
            selection::selection_update,
            selection::selection_end,
            selection::selection_set_rect,
            selection::selection_cancel,
            selection::selection_confirm,
            selection::selection_confirm_pin,
            selection::selection_confirm_window,
            export::export_prepare,
            export::export_commit,
            export::copy_text_to_clipboard,
            settings::get_settings,
            settings::set_settings,
            settings::reset_settings,
            ocr::ocr_extract,
            ocr::ocr_boxes,
            drive::gdrive_sign_in,
            drive::gdrive_sign_out,
            drive::gdrive_account,
            update::check_update,
            update::install_update,
            face::detect_faces,
            ocr::ocr_engine_status,
            ocr::ocr_list_langs,
            ocr::ocr_download_lang,
            ocr::ocr_translate_region,
            qr::qr_decode,
            translate::translate_text,
            translate::translate_service_available,
            translate::narrate_text,
            upload::upload_image,
            upload::upload_history,
            upload::upload_history_clear,
            upload::upload_delete,
            pin::pin_ready,
            pin::pin_close,
            pin::pin_editor_image,
            ready::frontend_mounted,
        ])
        .setup(move |app| {
            theme::sync();

            let handle = app.handle().clone();
            let _ = APP_HANDLE.set(handle.clone());
            tray::setup(&handle)?;
            update::check_in_background(&handle);
            settings::init_hotkeys(&handle).map_err(|e| e.to_string())?;
            if let Err(e) = overlay::prewarm(&handle) {
                eprintln!("[startup] failed to pre-warm overlay windows: {e}");
            }
            if let Err(e) = editor::prewarm(&handle) {
                eprintln!("[startup] failed to pre-warm editor window: {e}");
            }

            let main = app.get_webview_window("main").expect("main window must exist");
            match cli_command {
                // A CLI intent (cold-started region/window/open) triggers
                // its capture instead of showing the main window; the app
                // stays resident in the tray afterwards, same as a normal
                // hotkey-triggered capture. `dispatch` hands off to a
                // spawned task itself (see `cli::spawn_open`/`spawn_capture`)
                // -- see `ready::wait_for_mount` for why the prewarmed
                // overlay/editor windows still show up correctly even when
                // this is the very first thing to happen after a cold start.
                Some(cmd) => cli::dispatch(handle.clone(), cmd),
                None => main.show()?,
            }

            let main_for_close = main.clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_for_close.hide();
                }
            });

            Ok(())
        });

    let builder = images::register_shot_protocol(builder);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
