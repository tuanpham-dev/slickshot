use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::{CommandError, CommandResult};
use crate::settings::{get_settings, UploadProvider};

const STORE_FILE: &str = "uploads.json";
const STORE_KEY: &str = "uploads";
const MAX_HISTORY: usize = 100;

#[derive(Debug, Clone, Serialize)]
pub struct UploadResult {
    pub url: String,
    pub delete_url: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadEntry {
    pub url: String,
    pub delete_url: Option<String>,
    pub provider: String,
    pub uploaded_at: String,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; slickshot)")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("couldn't build HTTP client: {e}"))
}

/// Uploads to catbox.moe's anonymous file host -- no account, no expiry,
/// response body is the plain-text URL on success.
fn upload_catbox(png: Vec<u8>) -> Result<UploadResult, String> {
    let client = http_client()?;
    let part = reqwest::blocking::multipart::Part::bytes(png)
        .file_name("screenshot.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("reqtype", "fileupload")
        .part("fileToUpload", part);

    let resp = client
        .post("https://catbox.moe/user/api.php")
        .multipart(form)
        .send()
        .map_err(|e| format!("couldn't reach catbox.moe: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("catbox.moe returned {}", resp.status()));
    }
    let body = resp.text().map_err(|e| e.to_string())?;
    let url = body.trim().to_string();
    if !url.starts_with("https://") {
        return Err(format!("unexpected catbox.moe response: {url}"));
    }

    Ok(UploadResult {
        url,
        delete_url: None,
        provider: "catbox".to_string(),
    })
}

fn parse_imgur_response(body: &serde_json::Value) -> Result<(String, Option<String>), String> {
    let success = body.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        let message = body
            .get("data")
            .and_then(|d| d.get("error"))
            .and_then(|e| e.as_str())
            .unwrap_or("upload rejected");
        return Err(format!("Imgur error: {message}"));
    }

    let data = body.get("data").ok_or("unexpected Imgur response shape")?;
    let link = data
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or("Imgur response missing link")?
        .to_string();
    let deletehash = data.get("deletehash").and_then(|v| v.as_str());
    let delete_url = deletehash.map(|h| format!("https://imgur.com/delete/{h}"));

    Ok((link, delete_url))
}

/// Uploads to Imgur via its anonymous (Client-ID-only) API.
fn upload_imgur(png: Vec<u8>, client_id: &str) -> Result<UploadResult, String> {
    if client_id.trim().is_empty() {
        return Err(
            "Imgur is selected but no Client ID is set -- add one in Settings > Upload (create one free at api.imgur.com/oauth2/addclient)."
                .to_string(),
        );
    }

    let client = http_client()?;
    let part = reqwest::blocking::multipart::Part::bytes(png)
        .file_name("screenshot.png")
        .mime_str("image/png")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new().part("image", part);

    let resp = client
        .post("https://api.imgur.com/3/image")
        .header("Authorization", format!("Client-ID {client_id}"))
        .multipart(form)
        .send()
        .map_err(|e| format!("couldn't reach Imgur: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .map_err(|e| format!("couldn't parse Imgur response: {e}"))?;

    if !status.is_success() {
        let message = body
            .get("data")
            .and_then(|d| d.get("error"))
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Imgur returned {status}"));
        return Err(message);
    }

    let (url, delete_url) = parse_imgur_response(&body)?;
    Ok(UploadResult {
        url,
        delete_url,
        provider: "imgur".to_string(),
    })
}

/// Builds the bucket handle for the configured S3-compatible store. A blank
/// endpoint means AWS S3 proper (`Region::from_str` on the region name);
/// anything else is treated as a custom endpoint (MinIO, R2, B2), which
/// needs path-style addressing since those hosts generally don't serve
/// virtual-hosted bucket subdomains.
fn s3_bucket(settings: &crate::settings::Settings) -> Result<Box<s3::Bucket>, String> {
    use std::str::FromStr;

    for (value, label) in [
        (&settings.s3_bucket, "bucket"),
        (&settings.s3_access_key, "access key"),
        (&settings.s3_secret_key, "secret key"),
    ] {
        if value.trim().is_empty() {
            return Err(format!(
                "S3 is selected but no {label} is set -- fill it in under Settings > Upload."
            ));
        }
    }

    let credentials = s3::creds::Credentials::new(
        Some(&settings.s3_access_key),
        Some(&settings.s3_secret_key),
        None,
        None,
        None,
    )
    .map_err(|e| format!("invalid S3 credentials: {e}"))?;

    let endpoint = settings.s3_endpoint.trim();
    let region = if endpoint.is_empty() {
        s3::Region::from_str(settings.s3_region.trim()).map_err(|e| format!("invalid S3 region: {e}"))?
    } else {
        s3::Region::Custom {
            region: settings.s3_region.trim().to_string(),
            endpoint: endpoint.to_string(),
        }
    };

    let bucket = s3::Bucket::new(settings.s3_bucket.trim(), region, credentials)
        .map_err(|e| format!("couldn't open S3 bucket: {e}"))?;
    Ok(if endpoint.is_empty() {
        bucket
    } else {
        bucket.with_path_style()
    })
}

/// Object key for a new upload: `{prefix}{timestamp}-{short-uuid}.png`, with
/// the timestamp making keys sort chronologically and the uuid suffix
/// keeping two uploads in the same second from colliding.
fn s3_object_key(prefix: &str, timestamp: &str) -> String {
    let prefix = prefix.trim().trim_start_matches('/');
    let short: String = uuid::Uuid::new_v4().to_string().chars().take(8).collect();
    let stamp = timestamp.replace(':', "-");
    if prefix.is_empty() {
        format!("{stamp}-{short}.png")
    } else {
        let prefix = prefix.trim_end_matches('/');
        format!("{prefix}/{stamp}-{short}.png")
    }
}

/// Public URL for an uploaded object: `s3_public_base` when set (a CDN or
/// custom domain in front of the bucket), otherwise derived from the
/// endpoint/region and bucket.
fn s3_public_url(settings: &crate::settings::Settings, key: &str) -> String {
    let base = settings.s3_public_base.trim();
    if !base.is_empty() {
        return format!("{}/{key}", base.trim_end_matches('/'));
    }
    let bucket = settings.s3_bucket.trim();
    let endpoint = settings.s3_endpoint.trim();
    if endpoint.is_empty() {
        let region = settings.s3_region.trim();
        format!("https://{bucket}.s3.{region}.amazonaws.com/{key}")
    } else {
        let host = endpoint.trim_end_matches('/');
        let host = host.strip_prefix("https://").unwrap_or(host);
        let host = host.strip_prefix("http://").unwrap_or(host);
        format!("https://{host}/{bucket}/{key}")
    }
}

fn upload_s3(
    png: Vec<u8>,
    settings: &crate::settings::Settings,
    timestamp: &str,
) -> Result<UploadResult, String> {
    let bucket = s3_bucket(settings)?;
    let key = s3_object_key(&settings.s3_key_prefix, timestamp);

    let response = bucket
        .put_object_with_content_type(&key, &png, "image/png")
        .map_err(|e| format!("S3 upload failed: {e}"))?;
    if response.status_code() >= 300 {
        return Err(format!("S3 returned {}", response.status_code()));
    }

    Ok(UploadResult {
        url: s3_public_url(settings, &key),
        // The object key doubles as the delete handle; `upload_delete`
        // recovers it from this URL rather than storing a second field.
        delete_url: Some(format!("s3://{key}")),
        provider: "s3".to_string(),
    })
}

/// Dispatches to the configured provider's upload function. Split out from
/// the `upload_image` command (which additionally records history) so the
/// headless `upload` CLI command can reuse it without an `AppHandle`.
pub(crate) fn upload_core(
    settings: &crate::settings::Settings,
    png: Vec<u8>,
    uploaded_at: &str,
) -> Result<UploadResult, String> {
    match settings.upload_provider {
        UploadProvider::Catbox => upload_catbox(png),
        UploadProvider::Imgur => upload_imgur(png, &settings.imgur_client_id),
        UploadProvider::S3 => upload_s3(png, settings, uploaded_at),
    }
}

pub(crate) fn filename_timestamp_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

fn history_append(app: &AppHandle, entry: UploadEntry) -> CommandResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;

    let mut history: Vec<UploadEntry> = store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    history.insert(0, entry);
    history.truncate(MAX_HISTORY);

    let value = serde_json::to_value(&history).map_err(|e| CommandError::Image(e.to_string()))?;
    store.set(STORE_KEY, value);
    store.save().map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn upload_history(app: AppHandle) -> CommandResult<Vec<UploadEntry>> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    match store.get(STORE_KEY) {
        Some(value) => serde_json::from_value(value).map_err(|e| CommandError::Image(e.to_string())),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn upload_history_clear(app: AppHandle) -> CommandResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    store.delete(STORE_KEY);
    store.save().map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(())
}

/// Extracts the deletehash from an Imgur delete link
/// (`https://imgur.com/delete/{hash}`); `None` for anything else (catbox
/// entries have no delete_url at all).
fn deletehash_from_url(delete_url: &str) -> Option<&str> {
    delete_url.strip_prefix("https://imgur.com/delete/")
}

fn parse_imgur_delete_response(body: &serde_json::Value) -> Result<(), String> {
    let success = body.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if success {
        return Ok(());
    }
    let message = body
        .get("data")
        .and_then(|d| d.get("error"))
        .and_then(|e| e.as_str())
        .unwrap_or("delete rejected");
    Err(format!("Imgur error: {message}"))
}

/// Deletes an Imgur-hosted upload via its delete API, then removes the
/// matching entry from local history. Only Imgur entries have a delete_url
/// (catbox has no delete API), so this only ever applies to those.
#[tauri::command]
pub fn upload_delete(app: AppHandle, url: String) -> CommandResult<Vec<UploadEntry>> {
    let history = upload_history(app.clone())?;
    let entry = history
        .iter()
        .find(|e| e.url == url)
        .ok_or_else(|| CommandError::Image("upload not found in history".into()))?;
    let delete_url = entry
        .delete_url
        .as_deref()
        .ok_or_else(|| CommandError::Image("this upload has no delete link".into()))?;

    // S3 entries carry `s3://{key}` instead of an HTTP delete endpoint, and
    // are removed through the bucket API rather than Imgur's.
    if let Some(key) = delete_url.strip_prefix("s3://") {
        let settings = get_settings(app.clone())?;
        let bucket = s3_bucket(&settings).map_err(CommandError::Image)?;
        let response = bucket
            .delete_object(key)
            .map_err(|e| CommandError::Image(format!("S3 delete failed: {e}")))?;
        if response.status_code() >= 300 && response.status_code() != 404 {
            return Err(CommandError::Image(format!(
                "S3 returned {}",
                response.status_code()
            )));
        }
        return remove_from_history(&app, history, &url);
    }

    let hash = deletehash_from_url(delete_url)
        .ok_or_else(|| CommandError::Image("couldn't parse delete link".into()))?;

    let settings = get_settings(app.clone())?;
    if settings.imgur_client_id.trim().is_empty() {
        return Err(CommandError::Image(
            "Imgur is selected but no Client ID is set -- add one in Settings > Upload (create one free at api.imgur.com/oauth2/addclient).".into(),
        ));
    }

    let client = http_client().map_err(CommandError::Image)?;
    let resp = client
        .delete(format!("https://api.imgur.com/3/image/{hash}"))
        .header("Authorization", format!("Client-ID {}", settings.imgur_client_id))
        .send()
        .map_err(|e| CommandError::Image(format!("couldn't reach Imgur: {e}")))?;

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .map_err(|e| CommandError::Image(format!("couldn't parse Imgur response: {e}")))?;
    if !status.is_success() {
        let message = body
            .get("data")
            .and_then(|d| d.get("error"))
            .and_then(|e| e.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Imgur returned {status}"));
        return Err(CommandError::Image(message));
    }
    parse_imgur_delete_response(&body).map_err(CommandError::Image)?;

    remove_from_history(&app, history, &url)
}

/// Drops the entry for `url` from the stored history and returns what's left.
fn remove_from_history(
    app: &AppHandle,
    history: Vec<UploadEntry>,
    url: &str,
) -> CommandResult<Vec<UploadEntry>> {
    let remaining: Vec<UploadEntry> = history.into_iter().filter(|e| e.url != url).collect();
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    let value = serde_json::to_value(&remaining).map_err(|e| CommandError::Image(e.to_string()))?;
    store.set(STORE_KEY, value);
    store.save().map_err(|e| CommandError::Image(e.to_string()))?;

    Ok(remaining)
}

/// Uploads the flattened screenshot to the provider configured in Settings,
/// then records the result in the upload history store.
#[tauri::command]
pub fn upload_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<UploadResult> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "upload_image expects a raw binary body, not JSON".into(),
            ))
        }
    };

    let settings = get_settings(app.clone())?;
    let uploaded_at = filename_timestamp_rfc3339();
    let result = upload_core(&settings, bytes, &uploaded_at).map_err(CommandError::Image)?;

    history_append(
        &app,
        UploadEntry {
            url: result.url.clone(),
            delete_url: result.delete_url.clone(),
            provider: result.provider.clone(),
            uploaded_at,
        },
    )?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_imgur_success_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(
            r#"{"data":{"id":"abc123","link":"https://i.imgur.com/abc123.png","deletehash":"xyz789"},"success":true,"status":200}"#,
        )
        .unwrap();
        let (url, delete_url) = parse_imgur_response(&fixture).unwrap();
        assert_eq!(url, "https://i.imgur.com/abc123.png");
        assert_eq!(delete_url, Some("https://imgur.com/delete/xyz789".to_string()));
    }

    #[test]
    fn parses_imgur_error_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(
            r#"{"data":{"error":"Authentication required"},"success":false,"status":403}"#,
        )
        .unwrap();
        assert!(parse_imgur_response(&fixture).is_err());
    }

    #[test]
    fn imgur_missing_client_id_errors_without_network() {
        let err = upload_imgur(vec![0u8; 4], "").unwrap_err();
        assert!(err.contains("Client ID"));
    }

    #[test]
    fn deletehash_extracted_from_valid_imgur_url() {
        assert_eq!(
            deletehash_from_url("https://imgur.com/delete/xyz789"),
            Some("xyz789")
        );
    }

    #[test]
    fn deletehash_none_for_non_imgur_url() {
        assert_eq!(deletehash_from_url("https://files.catbox.moe/abc.png"), None);
    }

    #[test]
    fn parses_imgur_delete_success_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(r#"{"data":true,"success":true,"status":200}"#).unwrap();
        assert!(parse_imgur_delete_response(&fixture).is_ok());
    }

    #[test]
    fn parses_imgur_delete_error_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(
            r#"{"data":{"error":"Unable to find information"},"success":false,"status":404}"#,
        )
        .unwrap();
        assert!(parse_imgur_delete_response(&fixture).is_err());
    }

    fn s3_settings() -> crate::settings::Settings {
        crate::settings::Settings {
            s3_bucket: "shots".into(),
            s3_region: "us-east-1".into(),
            ..Default::default()
        }
    }

    #[test]
    fn s3_key_includes_prefix_and_is_unique() {
        let a = s3_object_key("screenshots/", "2026-08-25T10:00:00Z");
        let b = s3_object_key("screenshots/", "2026-08-25T10:00:00Z");
        assert!(a.starts_with("screenshots/2026-08-25T10-00-00Z-"), "got {a}");
        assert!(a.ends_with(".png"));
        assert_ne!(a, b, "same-second uploads must not collide");
    }

    #[test]
    fn s3_key_without_prefix_has_no_leading_slash() {
        let key = s3_object_key("", "2026-08-25T10:00:00Z");
        assert!(!key.starts_with('/'), "got {key}");
    }

    #[test]
    fn s3_public_url_defaults_to_aws_virtual_host() {
        let settings = s3_settings();
        assert_eq!(
            s3_public_url(&settings, "a.png"),
            "https://shots.s3.us-east-1.amazonaws.com/a.png"
        );
    }

    #[test]
    fn s3_public_url_uses_path_style_for_custom_endpoint() {
        let settings = crate::settings::Settings {
            s3_endpoint: "https://minio.example.com".into(),
            ..s3_settings()
        };
        assert_eq!(
            s3_public_url(&settings, "a.png"),
            "https://minio.example.com/shots/a.png"
        );
    }

    #[test]
    fn s3_public_url_prefers_configured_base() {
        let settings = crate::settings::Settings {
            s3_public_base: "https://cdn.example.com/".into(),
            ..s3_settings()
        };
        assert_eq!(s3_public_url(&settings, "a.png"), "https://cdn.example.com/a.png");
    }

    #[test]
    fn s3_missing_credentials_error_names_the_field() {
        let settings = crate::settings::Settings {
            s3_bucket: "shots".into(),
            ..Default::default()
        };
        let err = s3_bucket(&settings).unwrap_err();
        assert!(err.contains("access key"), "got {err}");
    }

    /// Live network test -- run manually with:
    ///   cargo test -- --ignored upload_catbox_live
    #[test]
    #[ignore]
    fn upload_catbox_live() {
        let mut img = image::RgbaImage::new(1, 1);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let result = upload_catbox(png).expect("catbox upload should succeed");
        println!("catbox url: {}", result.url);
        assert!(result.url.starts_with("https://"));
    }
}
