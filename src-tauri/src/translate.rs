use serde::Serialize;

use crate::commands::{CommandError, CommandResult};
use crate::settings::get_settings;

/// gtx text length cap: the endpoint takes `q` in a GET query string, so an
/// unbounded region's OCR text could produce an oversized/rejected request.
/// Screenshots rarely carry more prose than this; longer input is truncated
/// with `truncated: true` surfaced to the UI rather than failing outright.
const MAX_TRANSLATE_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize)]
pub struct Translation {
    pub translated: String,
    pub detected_lang: String,
    pub truncated: bool,
}

fn cap_input(text: &str) -> (String, bool) {
    if text.chars().count() > MAX_TRANSLATE_CHARS {
        (text.chars().take(MAX_TRANSLATE_CHARS).collect(), true)
    } else {
        (text.to_string(), false)
    }
}

/// GETs `url` via reqwest and returns the response body. `what` names the
/// endpoint for error messages (e.g. "translation service").
///
/// Google's abuse detection 429s `translate_a/single` based on the TLS
/// ClientHello fingerprint of whatever's making the request -- confirmed
/// live (this exact reqwest+native-tls config included) that it fails there
/// while the system `curl` binary passes. But `translate.google.com/m` and
/// `translate_tts` both pass via plain reqwest every time tested, so rather
/// than shell out to curl for every request, `translate()` just tries the
/// blocked endpoint first and falls back to the one that works (see
/// `translate` below) -- no external binary, no per-platform branching, and
/// no worse off on whatever endpoint actually needs it.
fn fetch_bytes(url: reqwest::Url, what: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; slickshot)")
        .build()
        .map_err(|e| format!("couldn't build HTTP client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("couldn't reach the {what}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("{what} returned {}", resp.status()));
    }

    resp.bytes()
        .map(|b| b.to_vec())
        .map_err(|e| format!("couldn't read {what} response: {e}"))
}

/// Cheap reachability probe for `translate_a/single` -- meant to be called
/// once when the user activates the translate/extract-text tool (overlay
/// hotkey, or the editor's OCR tool button), not on every actual
/// translation. The frontend caches the result for that tool session and
/// passes it as `translate`'s `try_primary`, so a whole session of
/// drag-selected regions skips straight to the mobile-page fallback when
/// the primary endpoint is already known blocked, instead of re-attempting
/// (and re-failing) it on every single region. Re-activating the tool
/// re-runs this probe, so recovery is picked up naturally without any
/// background polling or time-based cooldown.
#[tauri::command]
pub fn translate_service_available() -> bool {
    translate_via_json_api("test", "en").is_ok()
}

/// Translates `text` to `target`, preferring the `gtx` JSON API and falling
/// back to scraping the mobile HTML page if that fails (or if `try_primary`
/// is false -- see `translate_service_available` above) -- confirmed live
/// that `translate_a/single` can get rate-limited independently of the
/// client (curl included), while `translate.google.com/m` stays up. The
/// mobile page exposes no detected-language field of its own (unlike the
/// JSON API), so the fallback path runs local detection instead of just
/// reporting "und" -- callers (e.g. narrating the original text via Google's
/// TTS `tl` parameter) need a real language code, not a guess.
pub fn translate(text: &str, target: &str, try_primary: bool) -> Result<Translation, String> {
    let (input, truncated) = cap_input(text);

    let primary_err = if !try_primary {
        "translation service is currently unavailable".to_string()
    } else {
        match translate_via_json_api(&input, target) {
            Ok((translated, detected_lang)) => {
                return Ok(Translation {
                    translated,
                    detected_lang,
                    truncated,
                })
            }
            Err(e) => e,
        }
    };

    translate_via_mobile_page(&input, target)
        .map(|translated| Translation {
            translated,
            detected_lang: detect_lang_locally(&input).unwrap_or_else(|| "und".to_string()),
            truncated,
        })
        .map_err(|fallback_err| format!("{primary_err} (fallback also failed: {fallback_err})"))
}

/// Best-effort local language detection for the mobile-page fallback above.
/// Google's own detection (used whenever the JSON API succeeds) is
/// authoritative and always preferred; this only runs when that path has
/// already failed. `whatlang` reports ISO-639-3, so results are limited to
/// the languages `ocr::tesseract_to_iso1` can convert back to the
/// ISO-639-1-ish code space `detected_lang` callers expect -- anything else
/// falls through to `None`, same as if detection weren't attempted at all.
///
/// Doesn't use `Info::is_reliable()` (requires confidence > 0.9) -- that bar
/// is calibrated for long-form text and is rarely met by a short OCR'd
/// sentence even when the guess is correct (confirmed live: a clear-cut
/// 41-character English sentence scored only ~0.62). `confidence()` is a
/// length-scaled margin between the best and runner-up guess, so 0.5 still
/// cleanly separates real text (~0.6+ even when short) from near-noise
/// inputs like "hi" or "hello" (~0.01-0.03, often not even the right
/// language) -- confirmed against both live.
fn detect_lang_locally(text: &str) -> Option<String> {
    let info = whatlang::detect(text)?;
    if info.confidence() < 0.5 {
        return None;
    }
    crate::ocr::tesseract_to_iso1(info.lang().code()).map(|s| s.to_string())
}

/// Calls the unofficial Google Translate `gtx` endpoint -- no API key
/// required, decent quality, but no SLA and an undocumented response shape:
/// a JSON array whose `[0]` holds `[translated, original, ...]` segment
/// pairs (joined here) and whose `[2]` holds the auto-detected source
/// language.
fn translate_via_json_api(input: &str, target: &str) -> Result<(String, String), String> {
    let mut url = reqwest::Url::parse("https://translate.googleapis.com/translate_a/single")
        .expect("static URL is valid");
    url.query_pairs_mut()
        .append_pair("client", "gtx")
        .append_pair("sl", "auto")
        .append_pair("tl", target)
        .append_pair("dt", "t")
        .append_pair("q", input);

    let body = fetch_bytes(url, "translation service")?;

    let body: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| format!("couldn't parse translation response: {e}"))?;

    parse_gtx_response(&body)
}

/// Scrapes the translated text out of `translate.google.com/m` -- the same
/// mobile page translate.google.com falls back to for non-JS clients. Used
/// only when the `gtx` JSON API fails; see `translate` above.
fn translate_via_mobile_page(input: &str, target: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse("https://translate.google.com/m").expect("static URL is valid");
    url.query_pairs_mut()
        .append_pair("sl", "auto")
        .append_pair("tl", target)
        .append_pair("q", input);

    let body = fetch_bytes(url, "translation service (mobile)")?;
    parse_mobile_page(&String::from_utf8_lossy(&body))
}

fn parse_mobile_page(html: &str) -> Result<String, String> {
    let marker = "class=\"result-container\">";
    let start = html.find(marker).ok_or("unexpected translation page shape")? + marker.len();
    let end = html[start..].find('<').ok_or("unexpected translation page shape")?;

    Ok(unescape_html(&html[start..start + end]))
}

/// Unescapes the handful of HTML entities that can appear inside the
/// `/m` page's result text (Google escapes `&`, `<`, `>`, `"`, `'` there).
fn unescape_html(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn parse_gtx_response(body: &serde_json::Value) -> Result<(String, String), String> {
    let segments = body
        .get(0)
        .and_then(|v| v.as_array())
        .ok_or("unexpected translation response shape")?;

    let mut translated = String::new();
    for seg in segments {
        if let Some(s) = seg.get(0).and_then(|v| v.as_str()) {
            translated.push_str(s);
        }
    }

    let detected_lang = body
        .get(2)
        .and_then(|v| v.as_str())
        .unwrap_or("und")
        .to_string();

    Ok((translated, detected_lang))
}

/// Google's unofficial `translate_tts` endpoint truncates/rejects text past
/// roughly this length per request -- the same undocumented limit every
/// gTTS-style client works around by splitting into multiple requests and
/// concatenating the returned MP3 bytes (what the real translate.google.com
/// site does under the hood for its speaker-icon "Listen" button).
const MAX_TTS_CHUNK_CHARS: usize = 200;

/// Splits `text` into `MAX_TTS_CHUNK_CHARS`-ish chunks on whitespace
/// boundaries so words are never cut mid-token.
fn tts_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let would_be_len = if current.is_empty() { word.len() } else { current.len() + 1 + word.len() };
        if would_be_len > MAX_TTS_CHUNK_CHARS && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

/// Fetches spoken audio for `text` from Google Translate's own (unofficial,
/// no-API-key) TTS endpoint -- the same "Listen" feature translate.google.com
/// exposes via its speaker icon. Returns concatenated MP3 bytes across
/// however many chunks the text needed.
fn synthesize_speech(text: &str, lang: &str) -> Result<Vec<u8>, String> {
    let mut audio = Vec::new();
    for chunk in tts_chunks(text) {
        if chunk.is_empty() {
            continue;
        }
        let mut url = reqwest::Url::parse("https://translate.google.com/translate_tts")
            .expect("static URL is valid");
        url.query_pairs_mut()
            .append_pair("ie", "UTF-8")
            .append_pair("q", &chunk)
            .append_pair("tl", lang)
            .append_pair("client", "tw-ob");

        let bytes = fetch_bytes(url, "narration service")?;
        audio.extend_from_slice(&bytes);
    }

    Ok(audio)
}

/// Reads `text` aloud via Google Translate's TTS voice for `lang` -- the
/// speaker-icon "Listen" feature from translate.google.com.
#[tauri::command]
pub fn narrate_text(app: tauri::AppHandle, text: String, lang: String) -> CommandResult<Vec<u8>> {
    let settings = get_settings(app)?;
    if !settings.translate_enabled {
        return Err(CommandError::Image("translation is disabled in settings".into()));
    }
    synthesize_speech(&text, &lang).map_err(CommandError::Image)
}

#[tauri::command]
pub fn translate_text(app: tauri::AppHandle, text: String, try_primary: bool) -> CommandResult<Translation> {
    let settings = get_settings(app)?;
    if !settings.translate_enabled {
        return Err(CommandError::Image("translation is disabled in settings".into()));
    }
    translate(&text, &settings.translate_target, try_primary).map_err(CommandError::Image)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gtx_fixture() {
        // Shape of a real gtx response (segments truncated for brevity --
        // the parser only reads [0][i][0] and [2]).
        let fixture: serde_json::Value = serde_json::from_str(
            r#"[[["Xin chào","hello",null,null,3],[" thế giới","world",null,null,3]],null,"en"]"#,
        )
        .unwrap();
        let (translated, detected) = parse_gtx_response(&fixture).unwrap();
        assert_eq!(translated, "Xin chào thế giới");
        assert_eq!(detected, "en");
    }

    #[test]
    fn detect_lang_locally_recognizes_known_language() {
        assert_eq!(
            detect_lang_locally("This is a reasonably long sentence written in English."),
            Some("en".to_string())
        );
    }

    #[test]
    fn detect_lang_locally_gives_up_on_too_short_text() {
        // A couple of words is too little for whatlang to detect reliably.
        assert_eq!(detect_lang_locally("hi"), None);
    }

    #[test]
    fn parses_mobile_page_fixture() {
        // Captured live from https://translate.google.com/m?tl=vi&sl=auto&q=hello
        let fixture = r#"<div class="input-container">...</div><div class="result-container">Xin chào</div><div class="links-container">"#;
        assert_eq!(parse_mobile_page(fixture).unwrap(), "Xin chào");
    }

    #[test]
    fn parses_mobile_page_unescapes_html_entities() {
        let fixture = r#"<div class="result-container">Tom &amp; Jerry said &quot;hi&quot;</div>"#;
        assert_eq!(parse_mobile_page(fixture).unwrap(), "Tom & Jerry said \"hi\"");
    }

    #[test]
    fn mobile_page_missing_result_container_errors() {
        assert!(parse_mobile_page("<html><body>no result here</body></html>").is_err());
    }

    #[test]
    fn tts_chunks_keeps_short_text_as_one_chunk() {
        let chunks = tts_chunks("hello world");
        assert_eq!(chunks, vec!["hello world".to_string()]);
    }

    #[test]
    fn tts_chunks_splits_long_text_on_word_boundaries() {
        let long = "word ".repeat(60); // 300 chars, well past the 200 cap
        let chunks = tts_chunks(long.trim());
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.len() <= MAX_TTS_CHUNK_CHARS);
            assert!(!chunk.starts_with(' ') && !chunk.ends_with(' '));
        }
        // No words lost or mangled across the split.
        let rejoined: String = chunks.join(" ");
        assert_eq!(rejoined, long.trim());
    }

    #[test]
    fn tts_chunks_empty_input_yields_one_empty_chunk() {
        assert_eq!(tts_chunks(""), vec!["".to_string()]);
    }

    #[test]
    fn missing_segments_array_errors() {
        let fixture: serde_json::Value = serde_json::from_str("null").unwrap();
        assert!(parse_gtx_response(&fixture).is_err());
    }

    #[test]
    fn caps_long_input_and_marks_truncated() {
        let long = "a".repeat(MAX_TRANSLATE_CHARS + 500);
        let (input, truncated) = cap_input(&long);
        assert!(truncated);
        assert_eq!(input.chars().count(), MAX_TRANSLATE_CHARS);
    }

    #[test]
    fn short_input_not_truncated() {
        let (input, truncated) = cap_input("hello");
        assert!(!truncated);
        assert_eq!(input, "hello");
    }

    /// Live network test -- run manually with:
    ///   cargo test -- --ignored narrate_speech_live
    #[test]
    #[ignore]
    fn narrate_speech_live() {
        let audio = synthesize_speech("hello world", "en").expect("TTS request should succeed");
        assert!(!audio.is_empty());
        // MP3 files either start with an ID3 tag or a frame sync word
        // (0xFF 0xFB/0xFA/...) -- either is proof this is actually audio,
        // not an HTML error page from a blocked/rejected request.
        assert!(audio.starts_with(b"ID3") || (audio[0] == 0xFF && (audio[1] & 0xE0) == 0xE0));
    }

    /// Live network test -- run manually with:
    ///   cargo test -- --ignored translate_live
    #[test]
    #[ignore]
    fn translate_live() {
        let result = translate("This is a test sentence for translation.", "vi", true)
            .expect("translate should succeed, via fallback if needed");
        assert!(!result.translated.is_empty());
        println!("translated={:?} detected_lang={:?}", result.translated, result.detected_lang);
    }
}
