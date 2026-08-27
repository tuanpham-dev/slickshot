use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ImageEncoder, RgbaImage};
use tauri::http::{Request, Response, StatusCode};
use tauri::UriSchemeContext;
use tauri::{Builder, Manager, Runtime};

#[derive(Default)]
pub struct ImageStore(Mutex<HashMap<String, Arc<RgbaImage>>>);

impl ImageStore {
    pub fn insert(&self, image: RgbaImage) -> String {
        self.insert_arc(Arc::new(image))
    }

    pub fn insert_arc(&self, image: Arc<RgbaImage>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.0.lock().unwrap().insert(id.clone(), image);
        id
    }

    pub fn get(&self, id: &str) -> Option<Arc<RgbaImage>> {
        self.0.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}

/// PNG-encodes an in-memory RGBA frame. Used for actual file output (export,
/// OCR temp files) -- NOT for serving overlay/editor frames to the webview,
/// which fetch raw bytes instead (see `register_shot_protocol`) to avoid the
/// encode/decode round trip that used to dominate capture latency.
pub(crate) fn encode_png(image: &RgbaImage) -> Vec<u8> {
    let mut buf = Vec::new();
    let encoder = PngEncoder::new_with_quality(Cursor::new(&mut buf), CompressionType::Fast, FilterType::NoFilter);
    encoder
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
        .expect("PNG encoding of an in-memory RgbaImage cannot fail");
    buf
}

/// Serves stored frames as raw RGBA bytes with the dimensions in headers.
/// Raw instead of PNG: the frames are already decoded pixels in this
/// process, and PNG-encoding a full monitor (tens of MB) just for the
/// webview to immediately decode it back cost seconds per capture in dev
/// builds -- it was the dominant share of the hotkey-to-overlay latency.
/// The webview turns the bytes into an ImageBitmap via `fetchShotImage`
/// (src/lib/ipc.ts), which also sidesteps canvas cross-origin tainting.
///
/// Registered with the *asynchronous* protocol API and answered from a
/// spawned thread: on Linux the synchronous handler runs on the GTK main
/// thread, so serving several monitors' frames there would serialize the
/// responses and block the UI (including showing the overlay windows).
pub fn register_shot_protocol<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        "slickshot",
        |ctx: UriSchemeContext<R>, request: Request<Vec<u8>>, responder| {
            let id = request.uri().path().trim_start_matches('/').to_string();
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let store = app.state::<ImageStore>();
                let response = match store.get(&id) {
                    Some(image) => Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "application/octet-stream")
                        .header("X-Image-Width", image.width().to_string())
                        .header("X-Image-Height", image.height().to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Expose-Headers", "X-Image-Width, X-Image-Height")
                        .body(image.as_raw().clone())
                        .unwrap(),
                    None => Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(response);
            });
        },
    )
}
