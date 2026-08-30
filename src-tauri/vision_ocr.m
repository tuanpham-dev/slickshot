// Native macOS OCR via the Vision framework (VNRecognizeTextRequest), exposed
// to Rust through a tiny C ABI. Lets the app do on-device text recognition on
// macOS with no external `tesseract` binary. Compiled by build.rs with the
// `cc` crate and linked against Vision/Foundation/CoreGraphics/ImageIO only on
// macOS; the Rust side (src/ocr.rs) declares these via `extern "C"`.

#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

// Duplicate an NSString into a malloc'd, NUL-terminated UTF-8 buffer the Rust
// side takes ownership of and later frees via tas_vision_free.
static char *tas_copy_cstr(NSString *s) {
    const char *u = [s UTF8String];
    if (!u) {
        return NULL;
    }
    size_t n = strlen(u) + 1;
    char *out = malloc(n);
    if (out) {
        memcpy(out, u, n);
    }
    return out;
}

void tas_vision_free(char *p) {
    if (p) {
        free(p);
    }
}

// Recognize text in a PNG/encoded image.
//
// `png`/`len` is the encoded image; `lang_bcp47` is a Vision recognition
// language (e.g. "en-US", "vi-VT") or NULL/empty to let Vision auto-detect.
// Returns a malloc'd UTF-8 string of the recognized lines joined by '\n'
// (empty string when no text is found), or NULL on failure -- in which case
// `*err_out`, when non-NULL, is set to a malloc'd error message the caller
// frees with tas_vision_free.
char *tas_vision_ocr(const uint8_t *png, size_t len, const char *lang_bcp47, char **err_out) {
    @autoreleasepool {
        if (err_out) {
            *err_out = NULL;
        }

        NSData *data = [NSData dataWithBytes:png length:len];
        CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
        if (!src) {
            if (err_out) {
                *err_out = tas_copy_cstr(@"couldn't decode the image for OCR");
            }
            return NULL;
        }
        CGImageRef image = CGImageSourceCreateImageAtIndex(src, 0, NULL);
        CFRelease(src);
        if (!image) {
            if (err_out) {
                *err_out = tas_copy_cstr(@"couldn't create a CGImage for OCR");
            }
            return NULL;
        }

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        if (lang_bcp47 && lang_bcp47[0] != '\0') {
            request.recognitionLanguages = @[ [NSString stringWithUTF8String:lang_bcp47] ];
        }

        VNImageRequestHandler *handler =
            [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
        CGImageRelease(image);

        NSError *error = nil;
        BOOL ok = [handler performRequests:@[ request ] error:&error];
        if (!ok) {
            if (err_out) {
                *err_out = tas_copy_cstr(error ? error.localizedDescription
                                               : @"Vision text recognition failed");
            }
            return NULL;
        }

        NSMutableArray<NSString *> *lines = [NSMutableArray array];
        for (VNRecognizedTextObservation *obs in request.results) {
            VNRecognizedText *top = [[obs topCandidates:1] firstObject];
            if (top && top.string) {
                [lines addObject:top.string];
            }
        }
        return tas_copy_cstr([lines componentsJoinedByString:@"\n"]);
    }
}

// Recognize text and return one row per word with its pixel bounding box, as
// tab-separated "text\tx\ty\tw\th" lines (the same shape the Rust side parses
// out of tesseract's TSV on Linux, minus the header and level columns).
//
// Vision reports normalized boxes with a bottom-left origin, so each is scaled
// by the image dimensions and flipped to the top-left origin the rest of the
// app uses. Word boxes come from -boundingBoxForRange: over each whitespace-
// delimited substring of the observation's top candidate.
//
// Same ownership contract as tas_vision_ocr: malloc'd result, freed by the
// caller with tas_vision_free; NULL on failure with *err_out set.
char *tas_vision_ocr_boxes(const uint8_t *png, size_t len, const char *lang_bcp47, char **err_out) {
    @autoreleasepool {
        if (err_out) {
            *err_out = NULL;
        }

        NSData *data = [NSData dataWithBytes:png length:len];
        CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
        if (!src) {
            if (err_out) {
                *err_out = tas_copy_cstr(@"couldn't decode the image for OCR");
            }
            return NULL;
        }
        CGImageRef image = CGImageSourceCreateImageAtIndex(src, 0, NULL);
        CFRelease(src);
        if (!image) {
            if (err_out) {
                *err_out = tas_copy_cstr(@"couldn't create a CGImage for OCR");
            }
            return NULL;
        }

        size_t imgW = CGImageGetWidth(image);
        size_t imgH = CGImageGetHeight(image);

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        if (lang_bcp47 && lang_bcp47[0] != '\0') {
            request.recognitionLanguages = @[ [NSString stringWithUTF8String:lang_bcp47] ];
        }

        VNImageRequestHandler *handler =
            [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
        CGImageRelease(image);

        NSError *error = nil;
        BOOL ok = [handler performRequests:@[ request ] error:&error];
        if (!ok) {
            if (err_out) {
                *err_out = tas_copy_cstr(error ? error.localizedDescription
                                               : @"Vision text recognition failed");
            }
            return NULL;
        }

        NSMutableArray<NSString *> *rows = [NSMutableArray array];
        for (VNRecognizedTextObservation *obs in request.results) {
            VNRecognizedText *top = [[obs topCandidates:1] firstObject];
            if (!top || !top.string) {
                continue;
            }
            NSString *full = top.string;
            NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
            __block NSUInteger cursor = 0;
            for (NSString *word in [full componentsSeparatedByCharactersInSet:ws]) {
                if (word.length == 0) {
                    cursor += 1;
                    continue;
                }
                NSRange range = NSMakeRange(cursor, word.length);
                cursor += word.length + 1;

                VNRectangleObservation *box = [top boundingBoxForRange:range error:nil];
                if (!box) {
                    continue;
                }
                CGRect bb = box.boundingBox;
                double x = bb.origin.x * (double)imgW;
                // Flip the bottom-left origin to top-left.
                double y = (1.0 - bb.origin.y - bb.size.height) * (double)imgH;
                double w = bb.size.width * (double)imgW;
                double h = bb.size.height * (double)imgH;
                if (w <= 0 || h <= 0) {
                    continue;
                }
                [rows addObject:[NSString stringWithFormat:@"%@\t%.0f\t%.0f\t%.0f\t%.0f",
                                                           word, floor(x), floor(y), ceil(w), ceil(h)]];
            }
        }
        return tas_copy_cstr([rows componentsJoinedByString:@"\n"]);
    }
}
