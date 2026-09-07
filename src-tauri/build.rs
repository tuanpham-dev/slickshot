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

        // Screen recording (screen_record.m): ScreenCaptureKit feeding an
        // AVAssetWriter, so H.264 encoding is hardware-accelerated and the
        // region crop happens before a frame reaches Rust.
        println!("cargo:rerun-if-changed=screen_record.m");
        cc::Build::new()
            .file("screen_record.m")
            .flag("-fobjc-arc")
            // ScreenCaptureKit's audio capture is macOS 13+; the shim's
            // @available guards need the deployment target to match or the
            // compiler rejects the newer API calls outright.
            .flag("-mmacosx-version-min=13.0")
            .compile("tas_screen_record");

        for framework in [
            "Foundation",
            "Vision",
            "CoreGraphics",
            "ImageIO",
            "ScreenCaptureKit",
            "AVFoundation",
            "CoreMedia",
            "CoreVideo",
            "AppKit",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }

    tauri_build::build()
}
