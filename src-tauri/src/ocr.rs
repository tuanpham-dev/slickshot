use std::io::Write as _;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::{CommandError, CommandResult};
use crate::session::CaptureSession;
use crate::settings::{get_settings, set_settings};
use crate::translate;

/// ISO-639-1 code -> (tesseract language code, human label) for the
/// languages `ocr_download_lang` knows how to fetch. Only covers common
/// cases; an unmapped detected language simply won't offer a download
/// button in the UI. Keep in sync with `ISO_TO_OCR_LANG` in `src/lib/ipc.ts`.
const LANG_MAP: &[(&str, &str, &str)] = &[
    ("en", "eng", "English"),
    ("vi", "vie", "Vietnamese"),
    ("ja", "jpn", "Japanese"),
    ("ko", "kor", "Korean"),
    ("zh", "chi_sim", "Chinese (Simplified)"),
    ("zh-cn", "chi_sim", "Chinese (Simplified)"),
    ("zh-tw", "chi_tra", "Chinese (Traditional)"),
    ("de", "deu", "German"),
    ("fr", "fra", "French"),
    ("es", "spa", "Spanish"),
    ("ru", "rus", "Russian"),
    ("th", "tha", "Thai"),
    ("ar", "ara", "Arabic"),
    ("pt", "por", "Portuguese"),
    ("it", "ita", "Italian"),
];

fn iso_to_tesseract(iso: &str) -> (String, String) {
    let lower = iso.to_lowercase();
    LANG_MAP
        .iter()
        .find(|(code, _, _)| *code == lower)
        .map(|(_, tess, label)| (tess.to_string(), label.to_string()))
        .unwrap_or_else(|| (lower.clone(), lower.to_uppercase()))
}

/// Reverse of `iso_to_tesseract`: tesseract/ISO-639-3-ish code -> gtx-style
/// ISO-639-1 code. Used by `translate::detect_lang_locally` to convert a
/// local language-detection result (which reports ISO-639-3) into the code
/// space callers of `detected_lang` expect -- the same one Google's own
/// `translate_a/single` detection reports.
pub(crate) fn tesseract_to_iso1(tess: &str) -> Option<&'static str> {
    LANG_MAP.iter().find(|(_, t, _)| *t == tess).map(|(iso1, _, _)| *iso1)
}

/// User-writable directory for downloaded `.traineddata` files -- lets
/// `ocr_download_lang` add OCR languages without root (unlike distro
/// `tesseract-langpack-*` packages, which need install-time permissions
/// this app doesn't have).
fn tessdata_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tessdata");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Same directory `tessdata_dir` resolves via `AppHandle::app_data_dir`, but
/// reachable from the headless CLI path, which has no `AppHandle` -- verified
/// to be the same location (`dirs::data_dir()/dev.tuanp.slickshot/tessdata`)
/// on Linux.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))] // Tesseract path only; macOS/Windows use native OCR.
pub(crate) fn tessdata_dir_headless() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "couldn't determine the user data directory".to_string())?
        .join("dev.tuanp.slickshot")
        .join("tessdata");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))] // Tesseract path only; macOS/Windows use native OCR.
fn user_dir_langs_at(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) == Some("traineddata") {
                path.file_stem().map(|s| s.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect()
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))] // Tesseract path only; macOS/Windows use native OCR.
fn user_dir_langs(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = tessdata_dir(app) else {
        return Vec::new();
    };
    user_dir_langs_at(&dir)
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))] // Tesseract path only; macOS/Windows use native OCR.
fn system_langs() -> Vec<String> {
    let Ok(output) = std::process::Command::new("tesseract").arg("--list-langs").output() else {
        return Vec::new();
    };
    // tesseract 5.x prints the list to stdout; older 3.x/4.x builds print it
    // to stderr. Read both so this doesn't depend on the version, and drop
    // the "List of available languages ...:" header by content rather than by
    // position (it only appears on whichever stream carries the list).
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    combined
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("List of available languages"))
        .map(|l| l.to_string())
        .collect()
}

/// Returns every OCR language available to `ocr_extract`. On macOS that's the
/// Vision-supported set (built into the OS); elsewhere it's tesseract's
/// system-installed data plus anything `ocr_download_lang` has fetched into the
/// user data dir.
#[tauri::command]
pub fn ocr_list_langs(app: AppHandle) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let mut langs = vision::supported_tesseract_langs();
        langs.sort();
        langs
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let mut langs = windows_ocr::supported_tesseract_langs();
        langs.sort();
        langs
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut langs = system_langs();
        for l in user_dir_langs(&app) {
            if !langs.contains(&l) {
                langs.push(l);
            }
        }
        langs.sort();
        langs
    }
}

/// Downloads `<tess_code>.traineddata` from the `tessdata_fast` project
/// into the user tessdata dir, sets it as the active OCR language, and
/// returns the tesseract code now in use. `iso_code` is the gtx-style
/// detected-language code (e.g. "vi"); mapped via `LANG_MAP`.
#[tauri::command]
pub fn ocr_download_lang(app: AppHandle, iso_code: String) -> CommandResult<String> {
    let (tess_code, _label) = iso_to_tesseract(&iso_code);

    let dir = tessdata_dir(&app).map_err(CommandError::Image)?;
    let dest = dir.join(format!("{tess_code}.traineddata"));

    if !dest.exists() {
        let url =
            format!("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{tess_code}.traineddata");
        let resp = reqwest::blocking::get(&url)
            .map_err(|e| CommandError::Image(format!("couldn't reach tessdata_fast: {e}")))?;
        if !resp.status().is_success() {
            return Err(CommandError::Image(format!(
                "no OCR data found for language \"{tess_code}\" (HTTP {})",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .map_err(|e| CommandError::Image(format!("couldn't download OCR data: {e}")))?;

        let tmp_path = dir.join(format!("{tess_code}.traineddata.part"));
        {
            let mut f = std::fs::File::create(&tmp_path).map_err(|e| CommandError::Image(e.to_string()))?;
            f.write_all(&bytes).map_err(|e| CommandError::Image(e.to_string()))?;
        }
        std::fs::rename(&tmp_path, &dest).map_err(|e| CommandError::Image(e.to_string()))?;
    }

    let mut settings = get_settings(app.clone())?;
    settings.ocr_lang = tess_code.clone();
    set_settings(app, settings)?;

    Ok(tess_code)
}

/// Whether the platform's OCR engine is usable, and -- when it isn't -- an
/// install command for it. macOS/Vision and Windows/Windows.Media.Ocr are
/// bundled with the OS, so they're always available; only the Tesseract
/// path (Linux, and any other non-mac/Windows target) can be missing.
#[derive(Serialize)]
pub struct OcrEngineStatus {
    pub available: bool,
    pub install_hint: Option<String>,
}

/// Distro-appropriate Tesseract install command (a bare, runnable shell
/// command -- callers wrap it in backticks/code formatting as needed),
/// chosen by probing `PATH` for the package manager (first match wins) and
/// defaulting to the `apt` form, the common case, when none is found.
/// Advisory text only -- a slightly wrong package name still points the
/// user in the right direction, so this doesn't need to be exhaustive.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn linux_install_hint() -> String {
    const MANAGERS: &[(&str, &str)] = &[
        ("apt-get", "sudo apt install tesseract-ocr tesseract-ocr-eng"),
        ("dnf", "sudo dnf install tesseract tesseract-langpack-eng"),
        ("pacman", "sudo pacman -S tesseract tesseract-data-eng"),
        ("zypper", "sudo zypper install tesseract-ocr tesseract-ocr-eng"),
    ];
    let on_path = |bin: &str| {
        std::env::var_os("PATH").is_some_and(|paths| {
            std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file())
        })
    };
    MANAGERS
        .iter()
        .find(|(bin, _)| on_path(bin))
        .map(|(_, cmd)| cmd.to_string())
        .unwrap_or_else(|| MANAGERS[0].1.to_string())
}

/// Reports whether OCR is ready to use, so the UI can proactively guide the
/// user to install Tesseract on Linux instead of failing on first use.
#[tauri::command]
pub fn ocr_engine_status() -> OcrEngineStatus {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        OcrEngineStatus { available: true, install_hint: None }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let available = std::process::Command::new("tesseract").arg("--version").output().is_ok();
        OcrEngineStatus { available, install_hint: if available { None } else { Some(linux_install_hint()) } }
    }
}

/// Runs `tesseract -l <lang>` over `png_bytes`, adding `--tessdata-dir` when
/// `lang` only lives in the user download dir (not the system install).
/// `tessdata_dir` is `None` when it couldn't be resolved -- OCR still runs,
/// just without access to user-downloaded languages.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))] // Tesseract path only; macOS/Windows use native OCR.
fn run_tesseract_core(tessdata_dir: Option<&std::path::Path>, png_bytes: &[u8], lang: &str) -> Result<String, String> {
    run_tesseract_with_config(tessdata_dir, png_bytes, lang, None)
}

/// `config` names a tesseract output configfile (`tsv` for per-word rows with
/// bounding boxes); `None` is plain text.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))] // Tesseract path only; macOS/Windows use native OCR.
fn run_tesseract_with_config(
    tessdata_dir: Option<&std::path::Path>,
    png_bytes: &[u8],
    lang: &str,
    config: Option<&str>,
) -> Result<String, String> {
    let tmp_path = std::env::temp_dir().join(format!("slickshot-ocr-{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&tmp_path, png_bytes).map_err(|e| e.to_string())?;

    let mut cmd = std::process::Command::new("tesseract");
    cmd.arg(&tmp_path).arg("stdout").arg("-l").arg(lang);

    if let Some(dir) = tessdata_dir {
        if user_dir_langs_at(dir).iter().any(|l| l == lang) && !system_langs().iter().any(|l| l == lang) {
            cmd.arg("--tessdata-dir").arg(dir);
        }
    }

    // Positional and must come last: tesseract treats anything after the
    // configfile name as another configfile, not as a flag.
    if let Some(config) = config {
        cmd.arg(config);
    }

    let result = cmd.output();
    let _ = std::fs::remove_file(&tmp_path);

    let output = result.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            #[cfg(target_os = "macos")]
            let hint = "`brew install tesseract`";
            #[cfg(target_os = "windows")]
            let hint = "`winget install UB-Mannheim.TesseractOCR` (then confirm `tesseract --version` works in a fresh shell)";
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let hint = format!("`{}`", linux_install_hint());
            format!("Tesseract OCR isn't installed. Install it with {hint} and try again.")
        } else {
            format!("Couldn't run tesseract: {e}")
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Tesseract failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Native macOS OCR via the Vision framework, calling into the compiled
/// `vision_ocr.m` shim (see build.rs). Used in place of the `tesseract` CLI on
/// macOS, so the app needs no external OCR binary there.
#[cfg(target_os = "macos")]
mod vision {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_uchar};

    extern "C" {
        fn tas_vision_ocr(
            png: *const c_uchar,
            len: usize,
            lang_bcp47: *const c_char,
            err_out: *mut *mut c_char,
        ) -> *mut c_char;
        fn tas_vision_ocr_boxes(
            png: *const c_uchar,
            len: usize,
            lang_bcp47: *const c_char,
            err_out: *mut *mut c_char,
        ) -> *mut c_char;
        fn tas_vision_free(p: *mut c_char);
    }

    /// Vision recognition language (BCP-47) for a tesseract-style code, or
    /// `None` to let Vision auto-detect. Covers the same languages as
    /// `LANG_MAP`; all are supported by Vision on macOS 12+.
    fn tesseract_to_bcp47(tess: &str) -> Option<&'static str> {
        Some(match tess {
            "eng" => "en-US",
            "vie" => "vi-VT",
            "jpn" => "ja-JP",
            "kor" => "ko-KR",
            "chi_sim" => "zh-Hans",
            "chi_tra" => "zh-Hant",
            "deu" => "de-DE",
            "fra" => "fr-FR",
            "spa" => "es-ES",
            "rus" => "ru-RU",
            "tha" => "th-TH",
            "ara" => "ar-SA",
            "por" => "pt-BR",
            "ita" => "it-IT",
            _ => return None,
        })
    }

    /// tesseract-style codes for the Vision-supported languages the app can
    /// name/translate -- what `ocr_list_langs` reports on macOS so the Settings
    /// picker is populated and the translation popover never offers a
    /// (Tesseract-only) language download.
    pub fn supported_tesseract_langs() -> Vec<String> {
        [
            "eng", "vie", "jpn", "kor", "chi_sim", "chi_tra", "deu", "fra", "spa", "rus", "tha",
            "ara", "por", "ita",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    /// Recognize text in `png_bytes`, hinting `lang` (a tesseract-style code)
    /// when it maps to a Vision language; otherwise Vision auto-detects.
    pub fn recognize(png_bytes: &[u8], lang: &str) -> Result<String, String> {
        let lang_c = tesseract_to_bcp47(lang).map(|b| CString::new(b).unwrap());
        let lang_ptr = lang_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());

        let mut err: *mut c_char = std::ptr::null_mut();
        // SAFETY: `png_bytes` is valid for the call; `lang_ptr` is null or a
        // NUL-terminated string owned by `lang_c`, which outlives the call; the
        // returned pointer and any error string are ours to free below.
        let out = unsafe { tas_vision_ocr(png_bytes.as_ptr(), png_bytes.len(), lang_ptr, &mut err) };

        if out.is_null() {
            let msg = if err.is_null() {
                "Vision OCR failed".to_string()
            } else {
                let s = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
                unsafe { tas_vision_free(err) };
                s
            };
            return Err(msg);
        }

        let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        unsafe { tas_vision_free(out) };
        Ok(text.trim().to_string())
    }

    /// Per-word boxes as `text\tx\ty\tw\th` rows -- see `tas_vision_ocr_boxes`.
    pub fn recognize_boxes(png_bytes: &[u8], lang: &str) -> Result<String, String> {
        let lang_c = tesseract_to_bcp47(lang).map(|b| CString::new(b).unwrap());
        let lang_ptr = lang_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());

        let mut err: *mut c_char = std::ptr::null_mut();
        // SAFETY: identical contract to `recognize` above -- `png_bytes` is
        // valid for the call, `lang_ptr` outlives it, and both returned
        // pointers are ours to free.
        let out =
            unsafe { tas_vision_ocr_boxes(png_bytes.as_ptr(), png_bytes.len(), lang_ptr, &mut err) };

        if out.is_null() {
            let msg = if err.is_null() {
                "Vision OCR failed".to_string()
            } else {
                let s = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
                unsafe { tas_vision_free(err) };
                s
            };
            return Err(msg);
        }

        let rows = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        unsafe { tas_vision_free(out) };
        Ok(rows)
    }
}

/// Native Windows OCR via the Windows.Media.Ocr WinRT API, so the app needs no
/// external `tesseract` on Windows. Mirrors the macOS `vision` module; the
/// `windows` crate (already in the tree via tauri/wry) supplies the bindings.
#[cfg(target_os = "windows")]
mod windows_ocr {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    /// Windows OCR recognizer language tag for a tesseract-style code, or
    /// `None` to fall back to the user's profile languages. Mirrors `LANG_MAP`.
    fn tesseract_to_bcp47(tess: &str) -> Option<&'static str> {
        Some(match tess {
            "eng" => "en-US",
            "vie" => "vi",
            "jpn" => "ja",
            "kor" => "ko",
            "chi_sim" => "zh-Hans",
            "chi_tra" => "zh-Hant",
            "deu" => "de",
            "fra" => "fr",
            "spa" => "es",
            "rus" => "ru",
            "tha" => "th",
            "ara" => "ar",
            "por" => "pt",
            "ita" => "it",
            _ => return None,
        })
    }

    /// tesseract-style codes the app can name/translate. Actual availability
    /// depends on installed Windows language packs (English is essentially
    /// always present; otherwise the engine uses the user's profile
    /// languages), but reporting the set keeps the Settings picker populated
    /// and the translation popover from offering a (Tesseract-only) download.
    pub fn supported_tesseract_langs() -> Vec<String> {
        [
            "eng", "vie", "jpn", "kor", "chi_sim", "chi_tra", "deu", "fra", "spa", "rus", "tha",
            "ara", "por", "ita",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    /// Decode PNG bytes into a Bgra8 SoftwareBitmap, the format OcrEngine wants.
    fn decode_bitmap(png_bytes: &[u8]) -> windows::core::Result<SoftwareBitmap> {
        let stream = InMemoryRandomAccessStream::new()?;
        let output = stream.GetOutputStreamAt(0)?;
        let writer = DataWriter::CreateDataWriter(&output)?;
        writer.WriteBytes(png_bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let raw = decoder.GetSoftwareBitmapAsync()?.get()?;
        SoftwareBitmap::Convert(&raw, BitmapPixelFormat::Bgra8)
    }

    /// An OcrEngine for `lang` (a tesseract-style code) when its language is
    /// installed, else one built from the user's profile languages.
    fn engine_for(lang: &str) -> windows::core::Result<OcrEngine> {
        if let Some(tag) = tesseract_to_bcp47(lang) {
            let language = Language::CreateLanguage(&HSTRING::from(tag))?;
            if OcrEngine::IsLanguageSupported(&language)? {
                return OcrEngine::TryCreateFromLanguage(&language);
            }
        }
        OcrEngine::TryCreateFromUserProfileLanguages()
    }

    /// Runs the actual recognition. Must be called from a thread that isn't
    /// pumping a Win32 message loop -- see `recognize` below for why.
    fn recognize_blocking(png_bytes: &[u8], lang: &str) -> Result<String, String> {
        (|| -> windows::core::Result<String> {
            let bitmap = decode_bitmap(png_bytes)?;
            let engine = engine_for(lang)?;
            let result = engine.RecognizeAsync(&bitmap)?.get()?;
            Ok(result.Text()?.to_string())
        })()
        .map_err(|e| format!("Windows OCR failed: {e}"))
    }

    /// `IAsyncOperation::get()` (used throughout `recognize_blocking`) blocks
    /// until a completion callback fires, and delivering that callback onto an
    /// STA thread requires that thread's message pump to be running. Tauri
    /// dispatches sync commands inline on the WebView2 UI thread, which `tao`
    /// initializes as STA -- so calling `recognize_blocking` directly there
    /// deadlocks forever (the pump can't run while `.get()` blocks it),
    /// producing the "Reading text..." hang. Running it on a fresh thread
    /// initialized as MTA sidesteps this: MTA completions signal a plain
    /// event with no message-pump requirement, so `.get()` just waits and
    /// returns normally.
    pub fn recognize(png_bytes: &[u8], lang: &str) -> Result<String, String> {
        run_on_mta_thread(png_bytes, lang, recognize_blocking)
    }

    /// Per-word boxes as `text\tx\ty\tw\th` rows, matching the shape the
    /// macOS shim emits and the Linux TSV parser consumes.
    fn recognize_boxes_blocking(png_bytes: &[u8], lang: &str) -> Result<String, String> {
        (|| -> windows::core::Result<String> {
            let bitmap = decode_bitmap(png_bytes)?;
            let engine = engine_for(lang)?;
            let result = engine.RecognizeAsync(&bitmap)?.get()?;

            let mut rows = Vec::new();
            for line in result.Lines()? {
                for word in line.Words()? {
                    let text = word.Text()?.to_string();
                    if text.trim().is_empty() {
                        continue;
                    }
                    // BoundingRect is already in image pixels with a
                    // top-left origin, so no flip is needed here.
                    let r = word.BoundingRect()?;
                    rows.push(format!(
                        "{}\t{:.0}\t{:.0}\t{:.0}\t{:.0}",
                        text,
                        r.X.max(0.0),
                        r.Y.max(0.0),
                        r.Width.max(0.0),
                        r.Height.max(0.0)
                    ));
                }
            }
            Ok(rows.join("\n"))
        })()
        .map_err(|e| format!("Windows OCR failed: {e}"))
    }

    pub fn recognize_boxes(png_bytes: &[u8], lang: &str) -> Result<String, String> {
        run_on_mta_thread(png_bytes, lang, recognize_boxes_blocking)
    }

    /// Runs `work` on a fresh MTA thread, for the message-pump reason above.
    fn run_on_mta_thread(
        png_bytes: &[u8],
        lang: &str,
        work: fn(&[u8], &str) -> Result<String, String>,
    ) -> Result<String, String> {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

        let png_bytes = png_bytes.to_vec();
        let lang = lang.to_string();
        std::thread::spawn(move || {
            // SAFETY: CoUninitialize is called before this thread exits,
            // matching this CoInitializeEx exactly once, on the same thread.
            let init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let result = work(&png_bytes, &lang);
            if init.is_ok() {
                unsafe { CoUninitialize() };
            }
            result
        })
        .join()
        .unwrap_or_else(|_| Err("Windows OCR worker thread panicked".to_string()))
    }
}

/// One recognized word and where it sits, in pixels relative to the image
/// that was passed in. Consumed by auto-redaction (which censors the boxes
/// matching a PII pattern) and by the highlighter's text-line snapping.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OcrWordBox {
    pub text: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Parses tesseract's `tsv` output into word boxes.
///
/// The TSV has one row per layout element at increasing granularity; only
/// level 5 rows are words. Rows with a confidence of -1 carry no text (they
/// are the block/paragraph/line rows), and tesseract also emits empty-text
/// word rows for stray marks, which are dropped rather than returned as
/// zero-length matches.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn parse_tesseract_tsv(tsv: &str) -> Vec<OcrWordBox> {
    let mut out = Vec::new();
    for line in tsv.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let text = cols[11].trim();
        if text.is_empty() {
            continue;
        }
        let (Ok(x), Ok(y), Ok(w), Ok(h)) = (
            cols[6].parse::<i64>(),
            cols[7].parse::<i64>(),
            cols[8].parse::<u32>(),
            cols[9].parse::<u32>(),
        ) else {
            continue;
        };
        out.push(OcrWordBox {
            text: text.to_string(),
            x: x.max(0) as u32,
            y: y.max(0) as u32,
            w,
            h,
        });
    }
    out
}

/// Recognize text in a cropped PNG region using the platform OCR backend:
/// native Vision on macOS, native Windows.Media.Ocr on Windows, the
/// `tesseract` CLI elsewhere.
fn recognize(app: &AppHandle, png_bytes: &[u8], lang: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        vision::recognize(png_bytes, lang)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        windows_ocr::recognize(png_bytes, lang)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let dir = tessdata_dir(app).ok();
        run_tesseract_core(dir.as_deref(), png_bytes, lang)
    }
}

/// Headless equivalent of [`recognize`] for the `ocr` CLI command -- resolves
/// the tessdata dir via `tessdata_dir_headless` instead of an `AppHandle`
/// (the native macOS/Windows backends need neither).
pub(crate) fn recognize_headless(png_bytes: &[u8], lang: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        vision::recognize(png_bytes, lang)
    }
    #[cfg(target_os = "windows")]
    {
        windows_ocr::recognize(png_bytes, lang)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let dir = tessdata_dir_headless().ok();
        run_tesseract_core(dir.as_deref(), png_bytes, lang)
    }
}

/// Runs the `tesseract` CLI over a cropped PNG region and returns the
/// recognized text. Shells out to the system binary rather than linking
/// `libtesseract` via FFI bindings -- this machine has the `tesseract` CLI
/// installed but not `tesseract-devel`/`leptonica-devel` (the headers a
/// linked binding would need to build against), and shelling out is a
/// common, low-friction way to use an OCR engine the user already has.
#[tauri::command]
pub fn ocr_extract(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "ocr_extract expects a raw binary body, not JSON".into(),
            ))
        }
    };

    let lang = get_settings(app.clone())?.ocr_lang;
    recognize(&app, &bytes, &lang).map_err(CommandError::Image)
}

/// Word-level bounding boxes for the image in the request body, in image
/// pixels. Backs auto-redaction and the highlighter's text-line snapping;
/// both want *where* text is, which `ocr_extract` (plain text) can't say.
///
/// macOS/Windows emit the rows directly from their native engines; Linux
/// parses tesseract's TSV. All three land on the same `text\tx\ty\tw\th`
/// shape so a single parser covers them.
#[tauri::command]
pub fn ocr_boxes(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<Vec<OcrWordBox>> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "ocr_boxes expects a raw binary body, not JSON".into(),
            ))
        }
    };
    let lang = get_settings(app.clone())?.ocr_lang;

    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        let rows = vision::recognize_boxes(&bytes, &lang).map_err(CommandError::Image)?;
        Ok(parse_box_rows(&rows))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = &app;
        let rows = windows_ocr::recognize_boxes(&bytes, &lang).map_err(CommandError::Image)?;
        Ok(parse_box_rows(&rows))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let dir = tessdata_dir(&app).ok();
        let tsv = run_tesseract_with_config(dir.as_deref(), &bytes, &lang, Some("tsv"))
            .map_err(CommandError::Image)?;
        Ok(parse_tesseract_tsv(&tsv))
    }
}

/// Parses the native backends' `text\tx\ty\tw\th` rows.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    allow(dead_code)
)]
fn parse_box_rows(rows: &str) -> Vec<OcrWordBox> {
    rows.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() != 5 || cols[0].trim().is_empty() {
                return None;
            }
            Some(OcrWordBox {
                text: cols[0].to_string(),
                x: cols[1].parse().ok()?,
                y: cols[2].parse().ok()?,
                w: cols[3].parse().ok()?,
                h: cols[4].parse().ok()?,
            })
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrTranslateResult {
    pub origin: String,
    pub translated: Option<String>,
    pub detected_lang: Option<String>,
    pub truncated: bool,
}

/// Combined pipeline for translation mode: composite the region from the
/// frozen capture session, OCR it, and translate the result -- one IPC
/// round trip so the overlay's popover doesn't chain three separate calls.
#[tauri::command]
pub fn ocr_translate_region(
    app: AppHandle,
    session: tauri::State<'_, std::sync::Mutex<Option<CaptureSession>>>,
    rect: crate::geometry::PhysRect,
    try_primary: bool,
) -> CommandResult<OcrTranslateResult> {
    let png_bytes = {
        let guard = session.lock().unwrap();
        let session = guard.as_ref().ok_or(CommandError::NoSession)?;
        let composited = session.composite(rect);
        crate::images::encode_png(&composited)
    };

    let settings = get_settings(app.clone())?;
    let origin = recognize(&app, &png_bytes, &settings.ocr_lang).map_err(CommandError::Image)?;

    if origin.is_empty() {
        return Ok(OcrTranslateResult {
            origin,
            translated: None,
            detected_lang: None,
            truncated: false,
        });
    }

    if !settings.translate_enabled {
        return Ok(OcrTranslateResult {
            origin,
            translated: None,
            detected_lang: None,
            truncated: false,
        });
    }

    let translation = translate::translate(&origin, &settings.translate_target, try_primary)
        .map_err(CommandError::Image)?;

    Ok(OcrTranslateResult {
        origin,
        translated: Some(translation.translated),
        detected_lang: Some(translation.detected_lang),
        truncated: translation.truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `tesseract ... tsv` sample: a header row, the block/para/line
    /// rows that carry no text, and three word rows. Only the words, with
    /// their boxes, may come back.
    #[test]
    fn parses_word_rows_out_of_tesseract_tsv() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t640\t480\t-1\t\n\
2\t1\t1\t0\t0\t0\t36\t92\t220\t18\t-1\t\n\
3\t1\t1\t1\t0\t0\t36\t92\t220\t18\t-1\t\n\
4\t1\t1\t1\t1\t0\t36\t92\t220\t18\t-1\t\n\
5\t1\t1\t1\t1\t1\t36\t92\t64\t18\t96.1\tHello\n\
5\t1\t1\t1\t1\t2\t108\t92\t52\t18\t95.4\tthere\n\
5\t1\t1\t1\t1\t3\t168\t92\t88\t18\t12.0\t \n\
5\t1\t1\t1\t1\t4\t168\t92\t88\t18\t91.2\tworld\n";

        let boxes = parse_tesseract_tsv(tsv);
        assert_eq!(boxes.len(), 3, "only non-empty level-5 rows are words");
        assert_eq!(
            boxes[0],
            OcrWordBox { text: "Hello".into(), x: 36, y: 92, w: 64, h: 18 }
        );
        assert_eq!(boxes[2].text, "world");
    }

    /// Truncated or malformed rows must be skipped, not panic the parse.
    #[test]
    fn tsv_parser_skips_malformed_rows() {
        let tsv = "level\tleft\ttop\n5\t1\t1\n5\t1\t1\t1\t1\t1\tnope\tnope\tnope\tnope\t9\tword\n";
        assert!(parse_tesseract_tsv(tsv).is_empty());
    }

    /// The native macOS/Windows backends emit pre-formed rows; the shared
    /// parser must accept exactly five columns and reject anything else.
    #[test]
    fn parses_native_box_rows() {
        let rows = "Hello\t36\t92\t64\t18\nthere\t108\t92\t52\t18\n\t0\t0\t0\t0\nbad\t1\t2\n";
        let boxes = parse_box_rows(rows);
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[1], OcrWordBox { text: "there".into(), x: 108, y: 92, w: 52, h: 18 });
    }
}
