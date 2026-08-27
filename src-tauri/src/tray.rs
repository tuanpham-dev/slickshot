use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::{run_capture, CaptureMode, Capturer};
use crate::hotkeys::HotkeyBinding;
use crate::images::ImageStore;
use crate::session::CaptureSession;
use crate::settings::{get_settings, set_settings, Settings};

const DELAY_OPTIONS: [(u32, &str); 4] = [(0, "delay_0"), (3000, "delay_3"), (5000, "delay_5"), (10000, "delay_10")];

/// Monochrome, transparent-background icon distinct from the app's colored
/// window icon -- system trays typically expect a single-color glyph that
/// reads clearly at ~16-22px, which a busy colored icon doesn't. Drawn with
/// more margin filled than the window icon (see `assets/icon.svg`) so the
/// shape doesn't shrink to an indistinct dot at tray size.
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

/// Decodes the bundled tray PNG into an RGBA `tauri::image::Image`. Uses the
/// `image` crate directly (already a dependency for capture pixel handling)
/// rather than `Image::from_bytes`, which requires enabling tauri's
/// `image-png` cargo feature just for this one icon.
fn tray_icon() -> tauri::image::Image<'static> {
    let img = image::load_from_memory(TRAY_ICON_BYTES)
        .expect("bundled tray-icon.png is a valid PNG")
        .to_rgba8();
    let (width, height) = img.dimensions();
    tauri::image::Image::new_owned(img.into_raw(), width, height)
}

#[derive(Default)]
pub struct DelayMenuItems(pub Mutex<Vec<(u32, CheckMenuItem<tauri::Wry>)>>);

/// The 4 capture-mode tray items, kept so their label can be kept in sync
/// with `translate_enabled` (extraction alone vs. extraction+translation)
/// and their native accelerator with the user's actual configured/cleared
/// global hotkeys, instead of going stale after Settings changes them.
///
/// Note: on Linux the accelerator never actually renders in the tray's
/// popup menu -- muda only wires an item's accelerator into GTK's
/// `AccelGroup` when the menu is attached to a window
/// (`Menu::init_for_gtk_window`), which a tray context menu never is, so
/// `register_accel!`'s `add_accelerator` call is unconditionally skipped
/// there (confirmed by reading muda 0.19.3's GTK backend). Setting it here
/// anyway is still correct/harmless and is what actually renders on
/// platforms where tray menus can show it.
pub struct CaptureMenuItems(pub Mutex<Vec<(CaptureMode, MenuItem<tauri::Wry>)>>);

/// "Translate/Extract text" once translation is layered on top of OCR,
/// "Extract text" for plain OCR -- mirrors `MainWindow.tsx`'s tile label.
fn ocr_menu_label(translate_enabled: bool) -> &'static str {
    if translate_enabled {
        "Translate/Extract text"
    } else {
        "Extract text"
    }
}

fn capture_label(mode: CaptureMode, translate_enabled: bool) -> &'static str {
    match mode {
        CaptureMode::Region => "Capture region",
        CaptureMode::Screen => "Capture screen",
        CaptureMode::Window => "Capture window",
        CaptureMode::Translate => ocr_menu_label(translate_enabled),
        CaptureMode::Monitor => "Capture monitor",
        CaptureMode::RegionRepeat => "Repeat last region",
        CaptureMode::Color => "Pick color",
        CaptureMode::Measure => "Measure",
    }
}

fn accel_for(hotkeys: &[HotkeyBinding], mode: CaptureMode) -> Option<String> {
    hotkeys
        .iter()
        .find(|h| h.mode == mode)
        .map(|h| h.accelerator.clone())
        .filter(|a| !a.is_empty())
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let settings = get_settings(app.clone()).unwrap_or_default();
    let current_delay = settings.default_delay_ms;

    let open_main = MenuItem::with_id(app, "open_main", "Open SlickShot", true, None::<&str>)?;

    let capture_region = MenuItem::with_id(
        app,
        "capture_region",
        capture_label(CaptureMode::Region, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::Region),
    )?;
    let capture_screen = MenuItem::with_id(
        app,
        "capture_screen",
        capture_label(CaptureMode::Screen, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::Screen),
    )?;
    let capture_window = MenuItem::with_id(
        app,
        "capture_window",
        capture_label(CaptureMode::Window, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::Window),
    )?;
    let capture_ocr = MenuItem::with_id(
        app,
        "capture_translate",
        capture_label(CaptureMode::Translate, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::Translate),
    )?;

    let capture_repeat = MenuItem::with_id(
        app,
        "capture_region_repeat",
        capture_label(CaptureMode::RegionRepeat, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::RegionRepeat),
    )?;
    let pick_color = MenuItem::with_id(
        app,
        "capture_color",
        capture_label(CaptureMode::Color, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::Color),
    )?;
    let measure = MenuItem::with_id(
        app,
        "capture_measure",
        capture_label(CaptureMode::Measure, settings.translate_enabled),
        true,
        accel_for(&settings.hotkeys, CaptureMode::Measure),
    )?;

    let open_image = MenuItem::with_id(app, "open_image", "Open image…", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "open_settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    app.manage(CaptureMenuItems(Mutex::new(vec![
        (CaptureMode::Region, capture_region.clone()),
        (CaptureMode::Screen, capture_screen.clone()),
        (CaptureMode::Window, capture_window.clone()),
        (CaptureMode::Translate, capture_ocr.clone()),
        (CaptureMode::RegionRepeat, capture_repeat.clone()),
        (CaptureMode::Color, pick_color.clone()),
        (CaptureMode::Measure, measure.clone()),
    ])));

    let mut delay_items = Vec::new();
    let mut delay_submenu = SubmenuBuilder::new(app, "Delay");
    for (ms, id) in DELAY_OPTIONS {
        let item = CheckMenuItem::with_id(
            app,
            id,
            delay_label(ms),
            true,
            ms == current_delay,
            None::<&str>,
        )?;
        delay_submenu = delay_submenu.item(&item);
        delay_items.push((ms, item));
    }
    let delay_submenu = delay_submenu.build()?;
    app.manage(DelayMenuItems(Mutex::new(delay_items)));

    let menu = MenuBuilder::new(app)
        .item(&open_main)
        .separator()
        .item(&capture_region)
        .item(&capture_screen)
        .item(&capture_window)
        .item(&capture_ocr)
        .item(&capture_repeat)
        .item(&delay_submenu)
        .separator()
        .item(&pick_color)
        .item(&measure)
        .separator()
        .item(&open_image)
        .item(&settings_item)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .icon(tray_icon())
        .tooltip("SlickShot")
        .on_menu_event(handle_menu_event)
        .build(app)?;

    Ok(())
}

/// Keeps the tray menu in sync with settings -- called by
/// `settings::set_settings`/`reset_settings`. Updates each capture item's
/// label (extraction-alone vs. extraction+translation for the OCR item) and
/// native accelerator.
pub fn sync_menu(app: &AppHandle, settings: &Settings) {
    let Some(state) = app.try_state::<CaptureMenuItems>() else {
        return;
    };
    for (mode, item) in state.0.lock().unwrap().iter() {
        let _ = item.set_text(capture_label(*mode, settings.translate_enabled));
        let _ = item.set_accelerator(accel_for(&settings.hotkeys, *mode));
    }
}

fn delay_label(ms: u32) -> String {
    if ms == 0 {
        "Off".into()
    } else {
        format!("{}s", ms / 1000)
    }
}

fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().0.as_str();

    match id {
        "open_main" => show_main(app),
        "open_settings" => {
            show_main(app);
            // MainWindow.tsx listens for this and switches to the Settings
            // view -- without it, "Settings" just showed the main window at
            // whatever screen it already happened to be on.
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit("open_settings", ());
            }
        }
        "capture_region" => trigger(app, CaptureMode::Region),
        "capture_screen" => trigger(app, CaptureMode::Screen),
        "capture_window" => trigger(app, CaptureMode::Window),
        "capture_translate" => trigger(app, CaptureMode::Translate),
        "capture_region_repeat" => trigger(app, CaptureMode::RegionRepeat),
        "capture_color" => trigger(app, CaptureMode::Color),
        "capture_measure" => trigger(app, CaptureMode::Measure),
        "open_image" => open_image_dialog(app),
        "quit" => app.exit(0),
        _ if id.starts_with("delay_") => {
            if let Some((ms, _)) = DELAY_OPTIONS.iter().find(|(_, i)| *i == id) {
                update_delay(app, *ms);
            }
        }
        _ => {}
    }
}

fn trigger(app: &AppHandle, mode: CaptureMode) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let delay_ms = get_settings(app.clone()).map(|s| s.default_delay_ms).unwrap_or(0);
        let capturer = app.state::<Capturer>();
        let session = app.state::<Mutex<Option<CaptureSession>>>();
        let images = app.state::<ImageStore>();
        let _ = run_capture(&app, capturer.inner(), session.inner(), images.inner(), mode, delay_ms, None).await;
    });
}

fn update_delay(app: &AppHandle, ms: u32) {
    if let Ok(mut settings) = get_settings(app.clone()) {
        settings.default_delay_ms = ms;
        let _ = set_settings(app.clone(), settings);
    }
    let handles = app.state::<DelayMenuItems>();
    for (item_ms, item) in handles.0.lock().unwrap().iter() {
        let _ = item.set_checked(*item_ms == ms);
    }
}

fn open_image_dialog(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app = app.clone();
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "bmp"])
        .pick_file(move |path| {
            if let Some(path) = path {
                if let Some(path) = path.as_path() {
                    let app = app.clone();
                    let path = path.to_string_lossy().into_owned();
                    tauri::async_runtime::spawn(async move {
                        let images = app.state::<ImageStore>();
                        if let Err(e) = crate::commands::open_image_file(app.clone(), images, path).await {
                            eprintln!("[tray] failed to open image: {e}");
                        }
                    });
                }
            }
        });
}
