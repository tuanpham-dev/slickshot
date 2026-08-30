//! Google Drive uploads via an OAuth client the *user* creates in their own
//! Google Cloud project -- the same bring-your-own-credentials shape as
//! `imgur_client_id`, rather than shipping app-owned secrets in a binary
//! anyone can read.
//!
//! The flow is OAuth 2.0 with PKCE against a loopback redirect, which is what
//! Google documents for installed apps: open the consent page in the user's
//! browser, catch the redirect on a one-shot local listener, exchange the
//! code for tokens. Only the refresh token is persisted; access tokens are
//! short-lived and re-fetched on demand.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::{CommandError, CommandResult};
use crate::settings::get_settings;

const STORE_FILE: &str = "gdrive.json";
const REFRESH_TOKEN_KEY: &str = "refresh_token";
const ACCOUNT_KEY: &str = "account";
/// `drive.file` restricts the app to files it created itself -- it cannot
/// read anything already in the user's Drive.
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME: &str = "SlickShot";
/// How long the loopback listener waits for the browser redirect before
/// giving up, so an abandoned sign-in can't hold a port forever.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

/// Access tokens live ~1h; caching one avoids a refresh round trip per
/// upload. Cleared on sign-out.
static ACCESS_TOKEN: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("couldn't build HTTP client: {e}"))
}

/// URL-safe base64 without padding, as PKCE requires.
fn base64_url_nopad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[n as usize & 63] as char);
        }
    }
    out
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A random PKCE verifier and its S256 challenge.
fn pkce_pair() -> (String, String) {
    let verifier = base64_url_nopad(uuid::Uuid::new_v4().as_bytes())
        + &base64_url_nopad(uuid::Uuid::new_v4().as_bytes());
    let digest = sha256(verifier.as_bytes());
    (verifier, base64_url_nopad(&digest))
}

/// SHA-256, implemented here rather than adding a crate for the single hash
/// PKCE needs.
fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let mut message = input.to_vec();
    let bit_len = (input.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, value) in [a, b, c, d, e, f, g, hh].into_iter().enumerate() {
            h[i] = h[i].wrapping_add(value);
        }
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn store_get(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(key)?.as_str().map(|s| s.to_string())
}

fn store_set(app: &AppHandle, key: &str, value: Option<&str>) -> CommandResult<()> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| CommandError::Image(e.to_string()))?;
    match value {
        Some(v) => store.set(key, serde_json::Value::String(v.to_string())),
        None => {
            store.delete(key);
        }
    }
    store.save().map_err(|e| CommandError::Image(e.to_string()))
}

/// Waits for Google's redirect on `listener`, returning the `code` query
/// parameter. Replies with a small page so the browser tab doesn't sit on a
/// connection error after a successful sign-in.
fn await_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("couldn't configure the local listener: {e}"))?;

    let deadline = std::time::Instant::now() + CONSENT_TIMEOUT;
    for incoming in listener.incoming() {
        if std::time::Instant::now() > deadline {
            return Err("timed out waiting for the Google sign-in to finish".into());
        }
        let mut stream = incoming.map_err(|e| format!("local listener failed: {e}"))?;
        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| format!("local listener failed: {e}"))?,
        );
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .map_err(|e| format!("local listener failed: {e}"))?;

        // "GET /?state=...&code=... HTTP/1.1"
        let path = request_line.split_whitespace().nth(1).unwrap_or("");
        let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("code", v)) => code = Some(v.to_string()),
                Some(("state", v)) => state = Some(v.to_string()),
                Some(("error", v)) => error = Some(v.to_string()),
                _ => {}
            }
        }

        let done = code.is_some() || error.is_some();
        let body = if error.is_some() {
            "<h2>Sign-in failed</h2><p>You can close this tab and try again in SlickShot.</p>"
        } else if code.is_some() {
            "<h2>SlickShot is connected</h2><p>You can close this tab.</p>"
        } else {
            "<h2>Waiting for Google...</h2>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
        let _ = stream.flush();

        if let Some(e) = error {
            return Err(format!("Google returned an error: {e}"));
        }
        if let Some(code) = code {
            // State check guards against another local process racing a
            // request into the listener.
            if state.as_deref() != Some(expected_state) {
                return Err("the sign-in response did not match this request".into());
            }
            return Ok(code);
        }
        if done {
            break;
        }
    }
    Err("the Google sign-in did not complete".into())
}

/// Runs the full consent flow and persists the resulting refresh token.
#[tauri::command]
pub fn gdrive_sign_in(app: AppHandle) -> CommandResult<String> {
    let settings = get_settings(app.clone())?;
    let client_id = settings.gdrive_client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(CommandError::Image(
            "Add your Google OAuth client ID in Settings > Upload first.".into(),
        ));
    }

    // Port 0 lets the OS pick a free one; Google allows any loopback port
    // for installed apps, so nothing has to be pre-registered.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| CommandError::Image(format!("couldn't open a local port for sign-in: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| CommandError::Image(e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let (verifier, challenge) = pkce_pair();
    let state = base64_url_nopad(uuid::Uuid::new_v4().as_bytes());
    let consent_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        percent_encode(&client_id),
        percent_encode(&redirect_uri),
        percent_encode(SCOPE),
        percent_encode(&challenge),
        percent_encode(&state),
    );

    tauri_plugin_opener::open_url(&consent_url, None::<&str>).map_err(|e| {
        CommandError::Image(format!(
            "couldn't open the browser for sign-in ({e}). Open this URL manually:\n{consent_url}"
        ))
    })?;

    let code = await_code(listener, &state).map_err(CommandError::Image)?;

    let client = http_client().map_err(CommandError::Image)?;
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .map_err(|e| CommandError::Image(format!("couldn't reach Google: {e}")))?;

    let body: serde_json::Value = resp
        .json()
        .map_err(|e| CommandError::Image(format!("couldn't parse Google's response: {e}")))?;
    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        let detail = body
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or(err);
        return Err(CommandError::Image(format!("Google rejected the sign-in: {detail}")));
    }

    let refresh = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            CommandError::Image(
                "Google did not return a refresh token. Remove SlickShot from your Google account's third-party access and sign in again.".into(),
            )
        })?;
    store_set(&app, REFRESH_TOKEN_KEY, Some(refresh))?;

    if let Some(access) = body.get("access_token").and_then(|v| v.as_str()) {
        *ACCESS_TOKEN.lock().unwrap() = Some((access.to_string(), std::time::Instant::now()));
    }

    let account = fetch_account_email(&app).unwrap_or_else(|| "Connected".to_string());
    store_set(&app, ACCOUNT_KEY, Some(&account))?;
    Ok(account)
}

#[tauri::command]
pub fn gdrive_sign_out(app: AppHandle) -> CommandResult<()> {
    *ACCESS_TOKEN.lock().unwrap() = None;
    store_set(&app, REFRESH_TOKEN_KEY, None)?;
    store_set(&app, ACCOUNT_KEY, None)
}

/// The connected account's label, or `None` when not signed in -- drives the
/// Sign in / Sign out pair in Settings.
#[tauri::command]
pub fn gdrive_account(app: AppHandle) -> Option<String> {
    store_get(&app, REFRESH_TOKEN_KEY)?;
    Some(store_get(&app, ACCOUNT_KEY).unwrap_or_else(|| "Connected".to_string()))
}

fn fetch_account_email(app: &AppHandle) -> Option<String> {
    let token = access_token(app).ok()?;
    let client = http_client().ok()?;
    let body: serde_json::Value = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(token)
        .send()
        .ok()?
        .json()
        .ok()?;
    body.get("email").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// A valid access token, refreshing when the cached one is missing or old.
fn access_token(app: &AppHandle) -> Result<String, String> {
    {
        let cached = ACCESS_TOKEN.lock().unwrap();
        if let Some((token, issued)) = cached.as_ref() {
            // Refreshed well before the nominal hour so a long upload can't
            // start on a token that expires mid-request.
            if issued.elapsed() < Duration::from_secs(45 * 60) {
                return Ok(token.clone());
            }
        }
    }

    let refresh = store_get(app, REFRESH_TOKEN_KEY)
        .ok_or_else(|| "Not signed in to Google Drive -- connect it in Settings > Upload.".to_string())?;
    let settings = get_settings(app.clone()).map_err(|e| e.to_string())?;
    let client = http_client()?;
    let body: serde_json::Value = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", settings.gdrive_client_id.trim()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .map_err(|e| format!("couldn't reach Google: {e}"))?
        .json()
        .map_err(|e| format!("couldn't parse Google's response: {e}"))?;

    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        return Err(format!(
            "Google Drive sign-in expired ({err}). Reconnect it in Settings > Upload."
        ));
    }
    let token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Google did not return an access token")?
        .to_string();
    *ACCESS_TOKEN.lock().unwrap() = Some((token.clone(), std::time::Instant::now()));
    Ok(token)
}

/// Finds the app's folder, creating it on first use. Restricted to folders
/// this app created, which is all `drive.file` can see anyway.
fn ensure_folder(client: &reqwest::blocking::Client, token: &str) -> Result<String, String> {
    let query = format!(
        "mimeType='application/vnd.google-apps.folder' and name='{FOLDER_NAME}' and trashed=false"
    );
    let found: serde_json::Value = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(token)
        .query(&[("q", query.as_str()), ("fields", "files(id)"), ("pageSize", "1")])
        .send()
        .map_err(|e| format!("couldn't reach Google Drive: {e}"))?
        .json()
        .map_err(|e| format!("couldn't parse Google Drive's response: {e}"))?;

    if let Some(id) = found
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("id"))
        .and_then(|v| v.as_str())
    {
        return Ok(id.to_string());
    }

    let created: serde_json::Value = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "name": FOLDER_NAME,
            "mimeType": "application/vnd.google-apps.folder",
        }))
        .send()
        .map_err(|e| format!("couldn't reach Google Drive: {e}"))?
        .json()
        .map_err(|e| format!("couldn't parse Google Drive's response: {e}"))?;

    created
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Google Drive did not return a folder id".to_string())
}

/// Uploads `png` into the SlickShot folder and returns its shareable link.
/// Called through `upload::upload_core` like every other provider.
pub(crate) fn upload(
    png: Vec<u8>,
    settings: &crate::settings::Settings,
    uploaded_at: &str,
) -> Result<crate::upload::UploadResult, String> {
    if settings.gdrive_client_id.trim().is_empty() {
        return Err(
            "Google Drive is selected but no OAuth client ID is set -- add one in Settings > Upload."
                .to_string(),
        );
    }
    // `access_token` needs an AppHandle for the token store; the provider
    // signature doesn't carry one, so it is fetched from the global handle
    // the app registers at startup.
    let app = crate::app_handle().ok_or("the app is still starting up")?;
    let token = access_token(&app)?;
    let client = http_client()?;
    let folder = ensure_folder(&client, &token)?;

    let metadata = serde_json::json!({
        "name": format!("Screenshot {uploaded_at}.png"),
        "parents": [folder],
    });
    let form = reqwest::blocking::multipart::Form::new()
        .part(
            "metadata",
            reqwest::blocking::multipart::Part::text(metadata.to_string())
                .mime_str("application/json")
                .map_err(|e| e.to_string())?,
        )
        .part(
            "file",
            reqwest::blocking::multipart::Part::bytes(png)
                .mime_str("image/png")
                .map_err(|e| e.to_string())?,
        );

    let body: serde_json::Value = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink")
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .map_err(|e| format!("couldn't reach Google Drive: {e}"))?
        .json()
        .map_err(|e| format!("couldn't parse Google Drive's response: {e}"))?;

    if let Some(err) = body.get("error") {
        let message = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("upload rejected");
        return Err(format!("Google Drive error: {message}"));
    }

    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Google Drive did not return a file id")?
        .to_string();

    // Without this the link only works for the uploader, which defeats the
    // point of copying it to share.
    let _ = client
        .post(format!("https://www.googleapis.com/drive/v3/files/{id}/permissions"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "role": "reader", "type": "anyone" }))
        .send();

    let url = body
        .get("webViewLink")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://drive.google.com/file/d/{id}/view"));

    Ok(crate::upload::UploadResult {
        url,
        // Namespaced like the S3 provider's `s3://` so `upload_delete` can
        // tell which API to call.
        delete_url: Some(format!("gdrive:{id}")),
        provider: "gdrive".to_string(),
    })
}

/// Deletes a previously uploaded file. `id` comes from the `gdrive:` prefix
/// stored in the history entry's delete_url.
pub(crate) fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let token = access_token(app)?;
    let client = http_client()?;
    let resp = client
        .delete(format!("https://www.googleapis.com/drive/v3/files/{id}"))
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("couldn't reach Google Drive: {e}"))?;
    // 404 means it is already gone, which satisfies the request.
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        return Err(format!("Google Drive returned {}", resp.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known-answer tests for the hand-rolled SHA-256 that PKCE depends on:
    /// a wrong digest would only show up as an opaque Google rejection.
    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256(b"abc").to_vec(),
            hex(b"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            sha256(b"").to_vec(),
            hex(b"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        // Longer than one 64-byte block, to exercise the multi-block path.
        assert_eq!(
            sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq").to_vec(),
            hex(b"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        );
    }

    fn hex(s: &[u8]) -> Vec<u8> {
        s.chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn base64_url_has_no_padding_or_unsafe_characters() {
        let encoded = base64_url_nopad(&[251, 255, 190, 0, 1]);
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
    }

    #[test]
    fn percent_encoding_escapes_url_delimiters() {
        assert_eq!(percent_encode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(percent_encode("safe-_.~"), "safe-_.~");
    }

    /// The challenge must be the S256 hash of the verifier, not the verifier
    /// itself -- swapping them is a silent auth failure.
    #[test]
    fn pkce_challenge_is_the_hash_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert_ne!(verifier, challenge);
        assert_eq!(challenge, base64_url_nopad(&sha256(verifier.as_bytes())));
    }
}
