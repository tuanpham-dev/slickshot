fn main() {
    // On macOS, compile the native Vision OCR shim (vision_ocr.m) into the
    // binary and link the frameworks it needs, so OCR works without an
    // external `tesseract`. Other platforms keep shelling out to tesseract.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=vision_ocr.m");
        cc::Build::new()
            .file("vision_ocr.m")
            .flag("-fobjc-arc")
            .compile("tas_vision_ocr");
        for framework in ["Foundation", "Vision", "CoreGraphics", "ImageIO"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }

    tauri_build::build()
}
