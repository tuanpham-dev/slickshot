//! CLI surface: argument parsing, headless (no-GUI) command execution, and
//! the glue that lets an interactive capture (`region`/`window`/`open`)
//! either trigger on a freshly-launched app or forward to one already
//! running (see `lib::run` and `tauri_plugin_single_instance`).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use clap::{Args, Parser, Subcommand};
use image::RgbaImage;
use tauri::{AppHandle, Manager};

use crate::commands::{CaptureMode, CommandError, CommandResult, Capturer};
use crate::images::ImageStore;
use crate::session::CaptureSession;
use crate::settings::Settings;

#[derive(Parser, Debug)]
#[command(name = "slickshot", version, about = "Capture, annotate, and export screenshots")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<CliCommand>,
}

#[derive(Subcommand, Debug, Clone)]
pub enum CliCommand {
    /// Interactive region selection (drag to pick an area).
    Region {
        #[command(flatten)]
        capture: CaptureArgs,
    },
    /// Capture the full virtual screen (all monitors), headless.
    Screen {
        #[command(flatten)]
        capture: CaptureArgs,
    },
    /// Capture one monitor by index, headless. See `list-monitors`.
    Monitor {
        index: usize,
        #[command(flatten)]
        capture: CaptureArgs,
    },
    /// Interactive window pick, or a headless capture-by-title with `--title`.
    Window {
        /// Case-insensitive substring match against window titles. When set,
        /// runs headless (no overlay) instead of the interactive picker.
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        capture: CaptureArgs,
    },
    /// Open an existing image file in the annotation editor.
    Open { path: PathBuf },
    /// Extract text from an image via Tesseract OCR.
    Ocr {
        path: PathBuf,
        /// Tesseract language code (e.g. "eng", "vie"). Defaults to the
        /// configured OCR language.
        #[arg(long)]
        lang: Option<String>,
    },
    /// Decode QR codes found in an image.
    Qr { path: PathBuf },
    /// Upload an image to the configured host and print its URL.
    Upload { path: PathBuf },
    /// List monitors with their index, id, and geometry.
    ListMonitors,
}

impl CliCommand {
    /// True for commands that never need the GUI/webview and always run to
    /// completion in the invoking process, whether or not the app is
    /// already running elsewhere.
    pub fn is_headless(&self) -> bool {
        match self {
            CliCommand::Screen { .. }
            | CliCommand::Monitor { .. }
            | CliCommand::Ocr { .. }
            | CliCommand::Qr { .. }
            | CliCommand::Upload { .. }
            | CliCommand::ListMonitors => true,
            CliCommand::Window { title, .. } => title.is_some(),
            CliCommand::Region { .. } | CliCommand::Open { .. } => false,
        }
    }
}

#[derive(Args, Debug, Clone, Default)]
pub struct CaptureArgs {
    #[command(flatten)]
    pub output: OutputArgs,
    /// Delay before capturing, in milliseconds.
    #[arg(long, default_value_t = 0)]
    pub delay: u64,
}

#[derive(Args, Debug, Clone, Default)]
pub struct OutputArgs {
    /// Save to this file. Format is inferred from the extension (.png,
    /// .jpg/.jpeg, .webp, .avif).
    #[arg(short = 'o', long)]
    pub output: Option<PathBuf>,
    /// Copy the result to the clipboard.
    #[arg(short = 'c', long)]
    pub clipboard: bool,
    /// Write the encoded PNG to stdout (headless captures only).
    #[arg(long)]
    pub stdout: bool,
    /// Open the annotation editor instead of exporting directly
    /// (interactive captures only: region/window). Shorthand for
    /// `--post-capture editor`.
    #[arg(long)]
    pub edit: bool,
    /// What happens once the capture lands, overriding the saved setting for
    /// this run: open the editor, show the floating thumbnail, or neither.
    /// Interactive captures only (region/window), and only when no `-o`,
    /// `-c` or `--stdout` sink is given -- those export directly instead.
    #[arg(long, value_enum)]
    pub post_capture: Option<PostCaptureArg>,
    /// Keep the capture even when nothing else would, overriding the saved
    /// setting for this run: writes it to the save folder when
    /// `--post-capture none` is used, or when a thumbnail is left to time
    /// out. `--auto-save false` discards instead.
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    pub auto_save: Option<bool>,
}

/// Mirrors `settings::PostCaptureAction` as a clap-parseable value.
#[derive(clap::ValueEnum, Debug, Clone, Copy)]
pub enum PostCaptureArg {
    Editor,
    Thumbnail,
    None,
}

impl From<PostCaptureArg> for crate::settings::PostCaptureAction {
    fn from(value: PostCaptureArg) -> Self {
        match value {
            PostCaptureArg::Editor => Self::Editor,
            PostCaptureArg::Thumbnail => Self::Thumbnail,
            PostCaptureArg::None => Self::None,
        }
    }
}

/// Rejects flag combinations that only make sense for headless captures.
/// Interactive captures (region/window without --title) run in a process
/// that exits before the capture actually happens -- there is no PNG bytes
/// to write to stdout by the time that would matter.
pub fn validate_interactive(cmd: &CliCommand) -> Result<(), String> {
    let output = match cmd {
        CliCommand::Region { capture } => Some(&capture.output),
        CliCommand::Window { title: None, capture } => Some(&capture.output),
        _ => None,
    };
    if let Some(output) = output {
        if output.stdout {
            return Err("--stdout is not supported for interactive captures (region/window)".into());
        }
    }
    Ok(())
}

fn interactive_delay(cmd: &CliCommand) -> u64 {
    match cmd {
        CliCommand::Region { capture } => capture.delay,
        CliCommand::Window { capture, .. } => capture.delay,
        _ => 0,
    }
}

/// Sleeps out `--delay` locally in the invoking CLI process before an
/// interactive capture forwards to (or launches) the app -- see the plan's
/// "CLI-local `--delay` sleep" decision: one behavior regardless of whether
/// the app was already running, and the shell prompt returns only once the
/// capture actually starts.
pub fn sleep_for_delay(cmd: &CliCommand) {
    sleep_ms(interactive_delay(cmd));
}

fn sleep_ms(ms: u64) {
    if ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

// ---------------------------------------------------------------------
// Headless execution (screen / monitor / window --title / ocr / qr /
// upload / list-monitors) -- runs to completion in the invoking process,
// no GUI, regardless of whether the app is already running elsewhere.
// ---------------------------------------------------------------------

pub fn run_headless(cmd: CliCommand) -> Result<(), String> {
    match cmd {
        CliCommand::Screen { capture } => {
            sleep_ms(capture.delay);
            let capturer = crate::capture::default_capturer();
            let grabbed = CaptureSession::grab(capturer.as_ref()).map_err(|e| e.to_string())?;
            let rect = grabbed.virtual_rect;
            let img = grabbed.composite(rect);
            let settings = load_settings_headless();
            write_sink(&img, &capture.output, &settings)
        }
        CliCommand::Monitor { index, capture } => {
            sleep_ms(capture.delay);
            let capturer = crate::capture::default_capturer();
            let monitors = capturer.monitors().map_err(|e| e.to_string())?;
            let monitor = monitors.get(index).cloned().ok_or_else(|| {
                let valid: Vec<String> = monitors
                    .iter()
                    .enumerate()
                    .map(|(i, m)| format!("  {i}: \"{}\"", m.name))
                    .collect();
                format!("no monitor at index {index}. Valid indices:\n{}", valid.join("\n"))
            })?;
            let grabbed = CaptureSession::grab(capturer.as_ref()).map_err(|e| e.to_string())?;
            let frame = grabbed
                .frame_for_monitor(monitor.id)
                .ok_or_else(|| format!("no monitor with id {}", monitor.id))?;
            let img = (*frame.image).clone();
            let settings = load_settings_headless();
            write_sink(&img, &capture.output, &settings)
        }
        CliCommand::Window { title: Some(title), capture } => {
            sleep_ms(capture.delay);
            let capturer = crate::capture::default_capturer();
            let windows = capturer.windows().map_err(|e| e.to_string())?;
            let needle = title.to_lowercase();
            let window = windows
                .iter()
                .find(|w| w.title.to_lowercase().contains(&needle))
                .cloned()
                .ok_or_else(|| {
                    let titles: Vec<String> = windows.iter().map(|w| format!("  \"{}\"", w.title)).collect();
                    format!(
                        "no window title matching \"{title}\". Visible windows:\n{}",
                        titles.join("\n")
                    )
                })?;
            let grabbed = CaptureSession::grab(capturer.as_ref()).map_err(|e| e.to_string())?;
            let img = grabbed.composite(window.rect);
            let settings = load_settings_headless();
            write_sink(&img, &capture.output, &settings)
        }
        CliCommand::Ocr { path, lang } => {
            let img = image::open(&path)
                .map_err(|e| format!("couldn't read {}: {e}", path.display()))?
                .to_rgba8();
            let png_bytes = crate::images::encode_png(&img);
            let settings = load_settings_headless();
            let lang = lang.unwrap_or(settings.ocr_lang);
            let text = crate::ocr::recognize_headless(&png_bytes, &lang)?;
            println!("{text}");
            Ok(())
        }
        CliCommand::Qr { path } => {
            let img = image::open(&path)
                .map_err(|e| format!("couldn't read {}: {e}", path.display()))?
                .to_luma8();
            let payloads = crate::qr::decode_payloads(img);
            if payloads.is_empty() {
                return Err("no QR code found".to_string());
            }
            for payload in payloads {
                println!("{payload}");
            }
            Ok(())
        }
        CliCommand::Upload { path } => {
            let img = image::open(&path)
                .map_err(|e| format!("couldn't read {}: {e}", path.display()))?
                .to_rgba8();
            let png_bytes = crate::images::encode_png(&img);
            let settings = load_settings_headless();
            let timestamp = crate::upload::filename_timestamp_rfc3339();
            let result = crate::upload::upload_core(&settings, png_bytes, &timestamp)?;
            println!("{}", result.url);
            Ok(())
        }
        CliCommand::ListMonitors => {
            let capturer = crate::capture::default_capturer();
            let monitors = capturer.monitors().map_err(|e| e.to_string())?;
            for (i, m) in monitors.iter().enumerate() {
                let primary = if m.is_primary { " (primary)" } else { "" };
                println!(
                    "{i}: id={} \"{}\" {}x{}+{}+{}{primary}",
                    m.id, m.name, m.rect.w, m.rect.h, m.rect.x, m.rect.y
                );
            }
            Ok(())
        }
        CliCommand::Region { .. } | CliCommand::Window { title: None, .. } | CliCommand::Open { .. } => {
            unreachable!("interactive commands are dispatched via lib::run/dispatch, not run_headless")
        }
    }
}

/// Reads `settings.json` directly off disk (no `AppHandle`/webview needed),
/// falling back to `Settings::default()` on any failure -- missing file,
/// malformed JSON, or a `settings` key that fails to deserialize. Read-only;
/// never writes the store. Verified empirically that the store lives at
/// `dirs::data_dir()/dev.tuanp.slickshot/settings.json` (not the config dir)
/// on this machine, alongside `tessdata/` (see `ocr::tessdata_dir_headless`).
pub fn load_settings_headless() -> Settings {
    let Some(data_dir) = dirs::data_dir() else {
        return Settings::default();
    };
    let path = data_dir.join("dev.tuanp.slickshot").join(crate::settings::STORE_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Settings::default();
    };
    let Some(value) = root.get(crate::settings::STORE_KEY).cloned() else {
        return Settings::default();
    };
    crate::settings::parse_settings_value(value).unwrap_or_default()
}

/// Writes a headless capture to its output sink: `-o` (by extension),
/// `--stdout` (raw PNG), `-c` (clipboard, blocking), or -- with none of
/// those set -- quicksave to the configured folder.
fn write_sink(img: &RgbaImage, output: &OutputArgs, settings: &Settings) -> Result<(), String> {
    if let Some(path) = &output.output {
        write_to_path(img, path)?;
        println!("{}", path.display());
        return Ok(());
    }
    if output.stdout {
        let bytes = crate::images::encode_png(img);
        std::io::stdout().write_all(&bytes).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if output.clipboard {
        return copy_to_clipboard_headless(img.clone());
    }
    let path = crate::export::quicksave_file(settings);
    write_to_path(img, &path)?;
    println!("{}", path.display());
    Ok(())
}

/// Encodes `img` by `path`'s extension (`.png`, `.jpg`/`.jpeg`, `.webp`,
/// `.avif`) and writes
/// it, creating parent directories as needed. Shared by the headless sink
/// above and `export_to_sink` below (the GUI-side CLI-triggered capture
/// path), so `-o` behaves identically whether the app was already running.
pub(crate) fn write_to_path(img: &RgbaImage, path: &Path) -> Result<(), String> {
    let lower = path.to_string_lossy().to_lowercase();
    let format = if lower.ends_with(".png") {
        image::ImageFormat::Png
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        image::ImageFormat::Jpeg
    } else if lower.ends_with(".webp") {
        image::ImageFormat::WebP
    } else if lower.ends_with(".avif") {
        image::ImageFormat::Avif
    } else {
        return Err(format!(
            "unsupported output extension in \"{}\" (use .png, .jpg/.jpeg, .webp or .avif)",
            path.display()
        ));
    };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    match format {
        image::ImageFormat::Jpeg => image::DynamicImage::ImageRgba8(img.clone())
            .to_rgb8()
            .save_with_format(path, format)
            .map_err(|e| e.to_string()),
        _ => img.save_with_format(path, format).map_err(|e| e.to_string()),
    }
}

/// Headless clipboard copy: unlike the app's `export::copy_image_to_clipboard`
/// (which detaches a thread that survives because the app process keeps
/// running), a CLI process would exit and kill that thread before it ever
/// served a paste -- so this blocks the CLI itself until something else
/// takes ownership. Ctrl+C releases it.
#[cfg(target_os = "linux")]
fn copy_to_clipboard_headless(img: RgbaImage) -> Result<(), String> {
    use arboard::SetExtLinux;
    eprintln!("copied to clipboard; keeping it available until another app takes ownership (Ctrl+C to stop)...");
    let width = img.width() as usize;
    let height = img.height() as usize;
    let bytes = img.into_raw();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set()
        .wait()
        .image(arboard::ImageData {
            width,
            height,
            bytes: bytes.into(),
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn copy_to_clipboard_headless(img: RgbaImage) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: img.width() as usize,
            height: img.height() as usize,
            bytes: img.into_raw().into(),
        })
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------
// Interactive commands (region / window pick / open) -- dispatched
// in-process against a running `AppHandle`, either from `lib::run`'s
// `setup` (this process just became the resident instance) or from the
// `tauri_plugin_single_instance` callback (an already-running instance
// received a forwarded invocation).
// ---------------------------------------------------------------------

/// Per-app state: the pending output sink for a CLI-triggered interactive
/// capture. Set just before the capture is spawned, consumed by
/// `selection::selection_confirm_rect` once the user confirms a selection
/// (or cleared by `selection::selection_cancel` on Esc). `None` means
/// "no CLI capture pending" (the normal editor path) as well as "open the
/// editor" (`--edit`), which are handled identically once the sink is unset.
#[derive(Default)]
pub struct CliSink(pub Mutex<Option<OutputArgs>>);

/// Runs an interactive `CliCommand` against a live `AppHandle` -- either
/// this process's own app (cold start, called from `lib::run`'s `setup`) or
/// an already-running instance (called from the single-instance callback).
pub fn dispatch(app: AppHandle, cmd: CliCommand) {
    match cmd {
        CliCommand::Open { path } => spawn_open(app, path),
        CliCommand::Region { capture } => spawn_capture(app, CaptureMode::Region, capture),
        CliCommand::Window { title: None, capture } => spawn_capture(app, CaptureMode::Window, capture),
        CliCommand::Window { title: Some(_), .. } => {
            eprintln!("[cli] window --title is a headless capture and must run before the app starts");
        }
        _ => eprintln!("[cli] this command should have run headlessly and never reached the app"),
    }
}

fn spawn_open(app: AppHandle, path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let images = app.state::<ImageStore>();
        if let Err(e) =
            crate::commands::open_image_file(app.clone(), images, path.to_string_lossy().into_owned()).await
        {
            eprintln!("[cli] open failed: {e}");
        }
    });
}

fn spawn_capture(app: AppHandle, mode: CaptureMode, capture: CaptureArgs) {
    // `--edit` and `--post-capture` both mean "don't export directly", so
    // either one clears the sink and lets the capture reach `deliver_capture`.
    let routed = capture.output.edit || capture.output.post_capture.is_some();
    let sink = if routed { None } else { Some(capture.output.clone()) };
    *app.state::<CliSink>().0.lock().unwrap() = sink;
    *app.state::<crate::commands::PostCaptureOverride>().0.lock().unwrap() = capture
        .output
        .post_capture
        .map(Into::into)
        .or(capture.output.edit.then_some(crate::settings::PostCaptureAction::Editor));
    *app.state::<crate::commands::AutoSaveOverride>().0.lock().unwrap() = capture.output.auto_save;
    tauri::async_runtime::spawn(async move {
        let capturer = app.state::<Capturer>();
        let session = app.state::<Mutex<Option<CaptureSession>>>();
        let images = app.state::<ImageStore>();
        if let Err(e) =
            crate::commands::run_capture(&app, capturer.inner(), session.inner(), images.inner(), mode, 0, None).await
        {
            eprintln!("[cli] capture failed: {e}");
        }
    });
}

/// Exports a CLI-triggered capture straight to its sink instead of opening
/// the editor -- called from `selection::selection_confirm_rect` when
/// `CliSink` is set. Mirrors `write_sink`'s flag handling but runs in the
/// long-lived app process, so the clipboard copy can use the detached-thread
/// `export::copy_image_to_clipboard` (safe here: the app stays running)
/// instead of `copy_to_clipboard_headless`'s blocking version.
pub fn export_to_sink(app: &AppHandle, img: RgbaImage, output: &OutputArgs, settings: &Settings) -> CommandResult<()> {
    if let Some(path) = &output.output {
        write_to_path(&img, path).map_err(CommandError::Image)?;
        crate::export::notify_saved(app, &path.to_string_lossy());
        return Ok(());
    }
    if output.clipboard {
        return crate::export::copy_image_to_clipboard(img);
    }
    let path = crate::export::quicksave_file(settings);
    write_to_path(&img, &path).map_err(CommandError::Image)?;
    crate::export::notify_saved(app, &path.to_string_lossy());
    Ok(())
}
