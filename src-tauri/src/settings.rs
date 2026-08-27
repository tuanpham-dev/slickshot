use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

use crate::commands::{CommandError, CommandResult};
use crate::hotkeys::{self, HotkeyBinding};

pub(crate) const STORE_FILE: &str = "settings.json";
pub(crate) const STORE_KEY: &str = "settings";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeOverride {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadProvider {
    Imgur,
    /// Any S3-compatible object store (AWS S3, MinIO, Cloudflare R2,
    /// Backblaze B2), configured via the `s3_*` settings below.
    S3,
    /// Falls back here for any value serde doesn't recognize -- notably
    /// `"0x0"`, valid in a `settings.json` saved while that provider
    /// briefly existed (dropped as unreliable; see upload.rs history).
    /// Without this, an old settings.json with that value would fail to
    /// deserialize at all and crash the app on startup.
    #[serde(other)]
    #[default]
    Catbox,
}

/// First-run default for `translate_target`: the 2-letter language code
/// from `$LANG` (e.g. `vi_VN.UTF-8` -> `vi`), falling back to English when
/// unset or unparseable. Only consulted once, at `Settings::default()` --
/// after that the value lives in `settings.json` and this is never called.
fn default_translate_target() -> String {
    std::env::var("LANG")
        .ok()
        .and_then(|v| v.split(['_', '.']).next().map(|s| s.to_lowercase()))
        .filter(|s| s.len() == 2)
        .unwrap_or_else(|| "en".to_string())
}

fn default_ocr_lang() -> String {
    "eng".to_string()
}

fn default_export_scale() -> u8 {
    100
}

/// Parses `hotkeys` leniently: each array element that fails to deserialize
/// (most commonly a `mode` value naming a `CaptureMode` variant that has
/// since been removed, e.g. a retired capture mode) is silently dropped
/// instead of failing the whole `Settings` parse. Without this, deleting a
/// `CaptureMode` variant that a user's `settings.json` still references in
/// its `hotkeys` array would crash the app at startup -- the same failure
/// mode fixed for `UploadProvider` via `#[serde(other)]`, but `HotkeyBinding`
/// can't use that trick since the unrecognized value lives on a nested
/// field, not the top-level enum being matched.
fn deserialize_hotkeys<'de, D>(deserializer: D) -> Result<Vec<HotkeyBinding>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: Vec<serde_json::Value> = Deserialize::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| serde_json::from_value::<HotkeyBinding>(v).ok())
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub save_dir: Option<String>,
    pub default_format: ImageFormat,
    pub jpeg_quality: u8,
    #[serde(deserialize_with = "deserialize_hotkeys")]
    pub hotkeys: Vec<HotkeyBinding>,
    pub default_delay_ms: u32,
    pub open_editor_after_capture: bool,
    pub copy_on_capture: bool,
    pub theme: ThemeOverride,
    /// Master switch for OCR translation: OFF by default -- enabling it
    /// sends OCR'd text to Google's translate endpoint, which should be an
    /// explicit opt-in, not a surprise.
    #[serde(default)]
    pub translate_enabled: bool,
    /// Target language code for translation (e.g. "vi", "en").
    #[serde(default = "default_translate_target")]
    pub translate_target: String,
    /// Tesseract `-l` language code used for OCR (e.g. "eng", "vie").
    #[serde(default = "default_ocr_lang")]
    pub ocr_lang: String,
    /// Which image host the Upload export action sends screenshots to.
    #[serde(default)]
    pub upload_provider: UploadProvider,
    /// Client ID for Imgur's API (https://api.imgur.com/oauth2/addclient),
    /// required only when `upload_provider` is `Imgur`.
    #[serde(default)]
    pub imgur_client_id: String,
    /// Percent of native size exports are scaled to (100 = untouched).
    #[serde(default = "default_export_scale")]
    pub export_scale: u8,
    /// S3-compatible upload settings, used only when `upload_provider` is
    /// `S3`. `s3_endpoint` blank means AWS S3 proper; `s3_public_base` blank
    /// derives the public URL from endpoint + bucket + key.
    ///
    /// Note: the secret key is stored in plaintext in `settings.json`, the
    /// same as `imgur_client_id`. The Settings UI says so next to the field.
    #[serde(default)]
    pub s3_endpoint: String,
    #[serde(default)]
    pub s3_region: String,
    #[serde(default)]
    pub s3_bucket: String,
    #[serde(default)]
    pub s3_access_key: String,
    #[serde(default)]
    pub s3_secret_key: String,
    #[serde(default)]
    pub s3_key_prefix: String,
    #[serde(default)]
    pub s3_public_base: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            save_dir: None,
            default_format: ImageFormat::Png,
            jpeg_quality: 90,
            hotkeys: hotkeys::default_bindings(),
            default_delay_ms: 0,
            open_editor_after_capture: true,
            copy_on_capture: false,
            theme: ThemeOverride::System,
            translate_enabled: false,
            translate_target: default_translate_target(),
            ocr_lang: default_ocr_lang(),
            upload_provider: UploadProvider::default(),
            imgur_client_id: String::new(),
            export_scale: default_export_scale(),
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: String::new(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            s3_key_prefix: String::new(),
            s3_public_base: String::new(),
        }
    }
}

/// Parses a raw `settings` store value into `Settings`, applying the same
/// missing-hotkey backfill as `get_settings`. Split out so the headless CLI
/// path (`cli::load_settings_headless`), which reads `settings.json` off
/// disk directly rather than through a `tauri_plugin_store` handle, can
/// share the exact same parsing behavior instead of duplicating it.
pub(crate) fn parse_settings_value(value: serde_json::Value) -> CommandResult<Settings> {
    let mut settings: Settings =
        serde_json::from_value(value).map_err(|e| CommandError::Image(e.to_string()))?;
    fill_missing_hotkeys(&mut settings);
    Ok(settings)
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> CommandResult<Settings> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    match store.get(STORE_KEY) {
        Some(value) => parse_settings_value(value),
        None => Ok(Settings::default()),
    }
}

/// A `hotkeys` array is a plain `Vec`, not individually-defaulted fields, so
/// deserializing an old `settings.json` keeps exactly the bindings it was
/// saved with -- a mode added to `default_bindings()` after that file was
/// written (e.g. Translate) would otherwise never gain a binding for
/// existing users, silently leaving its shortcut unregistered forever.
fn fill_missing_hotkeys(settings: &mut Settings) {
    for binding in hotkeys::default_bindings() {
        if !settings.hotkeys.iter().any(|h| h.mode == binding.mode) {
            settings.hotkeys.push(binding);
        }
    }
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> CommandResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    let value = serde_json::to_value(&settings).map_err(|e| CommandError::Image(e.to_string()))?;
    store.set(STORE_KEY, value);
    store.save().map_err(|e| CommandError::Image(e.to_string()))?;

    hotkeys::sync(&app, settings.hotkeys.clone());
    crate::tray::sync_menu(&app, &settings);
    Ok(())
}

#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> CommandResult<Settings> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    store.delete(STORE_KEY);
    store.save().map_err(|e| CommandError::Image(e.to_string()))?;

    let defaults = Settings::default();
    hotkeys::sync(&app, defaults.hotkeys.clone());
    crate::tray::sync_menu(&app, &defaults);
    Ok(defaults)
}

pub fn init_hotkeys(app: &tauri::AppHandle) -> CommandResult<()> {
    let settings = get_settings(app.clone())?;
    hotkeys::sync(app, settings.hotkeys);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CaptureMode;

    /// A `settings.json` saved before the translation feature existed --
    /// missing `translate_enabled`/`translate_target`/`ocr_lang` entirely.
    /// Must still deserialize, falling back to the opt-in defaults.
    #[test]
    fn old_settings_json_without_translation_fields_deserializes() {
        let old_json = serde_json::json!({
            "save_dir": null,
            "default_format": "png",
            "jpeg_quality": 90,
            "hotkeys": [
                { "accelerator": "PrintScreen", "mode": "region" },
                { "accelerator": "Shift+PrintScreen", "mode": "screen" },
                { "accelerator": "Ctrl+PrintScreen", "mode": "window" }
            ],
            "default_delay_ms": 0,
            "open_editor_after_capture": true,
            "copy_on_capture": true,
            "theme": "system"
        });

        let settings: Settings = serde_json::from_value(old_json).expect("old settings.json must still deserialize");
        assert!(!settings.translate_enabled, "translation must default to opt-in (off)");
        assert_eq!(settings.ocr_lang, "eng");
        assert!(!settings.translate_target.is_empty());
        assert_eq!(settings.upload_provider, UploadProvider::Catbox);
        assert!(settings.imgur_client_id.is_empty());
    }

    /// Reproduces a real startup crash: a `settings.json` saved while the
    /// (since-removed) 0x0.st provider existed still has
    /// `"upload_provider": "0x0"` on disk. That value must fall back to
    /// Catbox, not fail deserialization -- an error here previously
    /// panicked the whole app in `setup()` before any window could open.
    #[test]
    fn unknown_upload_provider_value_falls_back_to_catbox() {
        let old_json = serde_json::json!({
            "save_dir": null,
            "default_format": "png",
            "jpeg_quality": 90,
            "hotkeys": [],
            "default_delay_ms": 0,
            "open_editor_after_capture": true,
            "copy_on_capture": true,
            "theme": "system",
            "upload_provider": "0x0",
            "imgur_client_id": ""
        });
        let settings: Settings = serde_json::from_value(old_json).expect("unknown provider value must not fail to deserialize");
        assert_eq!(settings.upload_provider, UploadProvider::Catbox);
    }

    /// Reproduces a real startup crash: a `settings.json` saved while a
    /// (since-removed) "pin" capture mode existed still has a hotkeys entry
    /// with `"mode": "pin"` on disk. That entry must be silently dropped,
    /// not fail the whole `hotkeys` array's deserialization -- the same
    /// failure class as `unknown_upload_provider_value_falls_back_to_catbox`,
    /// but for a value nested inside an array element.
    #[test]
    fn hotkeys_entry_with_retired_mode_is_dropped_not_fatal() {
        let old_json = serde_json::json!({
            "save_dir": null,
            "default_format": "png",
            "jpeg_quality": 90,
            "hotkeys": [
                { "accelerator": "PrintScreen", "mode": "region" },
                { "accelerator": "Ctrl+Alt+PrintScreen", "mode": "pin" }
            ],
            "default_delay_ms": 0,
            "open_editor_after_capture": true,
            "copy_on_capture": true,
            "theme": "system"
        });
        let settings: Settings =
            serde_json::from_value(old_json).expect("a retired hotkey mode must not fail deserialization");
        assert_eq!(settings.hotkeys.len(), 1);
        assert_eq!(settings.hotkeys[0].mode, CaptureMode::Region);
    }

    /// Reproduces the real bug found in QA: a `settings.json` saved before
    /// the Translate hotkey existed keeps its old 3-entry `hotkeys` array
    /// verbatim on deserialize (plain `Vec`, not per-field defaulted), so
    /// without `fill_missing_hotkeys` the shortcut would never be
    /// registerable for upgrading users.
    #[test]
    fn old_hotkeys_array_gains_new_mode_bindings() {
        let mut settings = Settings {
            hotkeys: vec![
                HotkeyBinding { accelerator: "PrintScreen".into(), mode: CaptureMode::Region },
                HotkeyBinding { accelerator: "Shift+PrintScreen".into(), mode: CaptureMode::Screen },
                HotkeyBinding { accelerator: "Ctrl+PrintScreen".into(), mode: CaptureMode::Window },
            ],
            ..Settings::default()
        };
        fill_missing_hotkeys(&mut settings);
        assert!(settings.hotkeys.iter().any(|h| h.mode == CaptureMode::Translate));
        // still exactly one binding per mode -- no duplicates introduced
        assert_eq!(settings.hotkeys.iter().filter(|h| h.mode == CaptureMode::Region).count(), 1);
    }
}
