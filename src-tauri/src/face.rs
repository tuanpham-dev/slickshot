use std::sync::OnceLock;

use serde::Serialize;

use crate::commands::{CommandError, CommandResult};

/// The SeetaFace frontal detection model, embedded so face censoring works
/// offline with no first-use download. Redistributed under the BSD 2-Clause
/// license it ships with; the required copyright notice is kept verbatim
/// alongside it in `models/LICENSE-seetaface.txt`.
const MODEL_BYTES: &[u8] = include_bytes!("../models/seeta_fd_frontal_v1.0.bin");

/// Parsing the model takes long enough to be worth doing once per process
/// rather than per detection. The parsed `Model` is cheap to clone into a
/// detector, which is what actually holds mutable detection state.
fn model() -> CommandResult<&'static rustface::Model> {
    static MODEL: OnceLock<Option<rustface::Model>> = OnceLock::new();
    MODEL
        .get_or_init(|| rustface::read_model(MODEL_BYTES).ok())
        .as_ref()
        .ok_or_else(|| CommandError::Image("the face detection model failed to load".into()))
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct FaceBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Detects frontal faces in the PNG in the request body, returning their
/// boxes in image pixels. The caller turns them into censor shapes.
///
/// Runs on a blocking-friendly command (not `async`): detection is pure CPU
/// work with no awaits, and Tauri dispatches sync commands off the main
/// thread for a raw-body request.
#[tauri::command]
pub fn detect_faces(request: tauri::ipc::Request<'_>) -> CommandResult<Vec<FaceBox>> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(CommandError::Image(
                "detect_faces expects a raw binary body, not JSON".into(),
            ))
        }
    };

    detect_in_image(&bytes).map_err(CommandError::Image)
}

/// Detection core, split from the command so it can be exercised directly by
/// tests (and from any decodable format, not just the PNG the editor sends).
pub(crate) fn detect_in_image(bytes: &[u8]) -> Result<Vec<FaceBox>, String> {
    let image = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    // The detector requires single-channel input.
    let gray = image.to_luma8();
    let (width, height) = (gray.width(), gray.height());
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }

    let mut detector = rustface::create_detector_with_model(model().map_err(|e| e.to_string())?.clone());
    // Tuned for screenshots rather than photographs: faces in a captured
    // window are usually small, and a screenshot has far more hard edges to
    // produce false positives than a photo, so the score threshold is raised
    // to compensate for the lowered minimum size.
    detector.set_min_face_size(24);
    detector.set_score_thresh(2.2);
    detector.set_pyramid_scale_factor(0.8);
    detector.set_slide_window_step(4, 4);

    let faces = detector.detect(&rustface::ImageData::new(&gray, width, height));

    Ok(faces
        .iter()
        .map(|f| {
            let b = f.bbox();
            // The detector can report boxes that run past the edge on a face
            // that is partly out of frame; clamp so the censor shape stays
            // inside the image.
            let x = b.x().max(0) as u32;
            let y = b.y().max(0) as u32;
            FaceBox {
                x: x.min(width),
                y: y.min(height),
                w: b.width().min(width.saturating_sub(x)),
                h: b.height().min(height.saturating_sub(y)),
            }
        })
        .filter(|f| f.w > 0 && f.h > 0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded model must actually parse -- a truncated or wrong-format
    /// blob would otherwise only surface the first time a user clicks
    /// "Censor faces".
    #[test]
    fn embedded_model_parses() {
        assert!(model().is_ok(), "the bundled SeetaFace model must load");
    }

    /// A blank image has no faces. Goes through `detect_in_image` rather than
    /// driving the detector directly, so the decode/grayscale/clamp path the
    /// command actually uses is the one under test.
    ///
    /// True positives are verified manually against real portraits (see
    /// docs/TESTING.md) -- no photo is committed as a fixture.
    #[test]
    fn blank_image_reports_no_faces() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(64, 64, image::Rgba([255, 255, 255, 255]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        assert!(detect_in_image(png.get_ref()).unwrap().is_empty());
    }

    /// Undecodable input must surface as an error, not a panic.
    #[test]
    fn garbage_input_errors_cleanly() {
        assert!(detect_in_image(b"not an image").is_err());
    }
}
