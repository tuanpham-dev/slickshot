use crate::commands::{CommandError, CommandResult};

/// Decodes every QR payload in an already-decoded image. Split out from the
/// command so it can be tested without constructing a Tauri IPC request, and
/// reused by the headless `qr` CLI command (`cli::run_headless`).
pub(crate) fn decode_payloads(image: image::GrayImage) -> Vec<String> {
    let mut prepared = rqrr::PreparedImage::prepare(image);
    prepared
        .detect_grids()
        .into_iter()
        // A grid that's found but undecodable (damaged, or a false positive
        // from surrounding UI) is skipped rather than failing the whole
        // request -- other codes in the same region should still come back.
        .filter_map(|grid| grid.decode().ok())
        .map(|(_meta, content)| content)
        .filter(|content| !content.is_empty())
        .collect()
}

/// Decodes every QR code found in a PNG region and returns their payloads
/// (empty when there are none -- that is the common case, not an error).
///
/// Takes the same raw-PNG body the frontend already builds for `ocr_extract`
/// so the Extract-text gesture can decode text and QR codes from one crop.
/// Pure Rust via `rqrr`, so unlike OCR this needs no external binary.
#[tauri::command]
pub fn qr_decode(request: tauri::ipc::Request<'_>) -> CommandResult<Vec<String>> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "qr_decode expects a raw binary body, not JSON".into(),
            ))
        }
    };

    let image = image::load_from_memory(&bytes)
        .map_err(|e| CommandError::Image(e.to_string()))?
        .to_luma8();

    Ok(decode_payloads(image))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qr_image(payload: &str) -> image::GrayImage {
        qrcode::QrCode::new(payload)
            .expect("payload encodes")
            .render::<image::Luma<u8>>()
            .quiet_zone(true)
            .module_dimensions(6, 6)
            .build()
    }

    #[test]
    fn decodes_a_generated_qr_code() {
        let payloads = decode_payloads(qr_image("https://example.com/shot"));
        assert_eq!(payloads, vec!["https://example.com/shot".to_string()]);
    }

    #[test]
    fn plain_image_yields_no_payloads() {
        // A blank field has no finder patterns: the common case for a region
        // dragged over ordinary UI, which must come back empty, not error.
        let blank = image::GrayImage::from_pixel(200, 200, image::Luma([255]));
        assert!(decode_payloads(blank).is_empty());
    }
}
