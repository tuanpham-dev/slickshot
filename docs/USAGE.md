# Usage

[← Back to README](../README.md)

## Main window

One tile per capture mode — Region, Screen, Window, a per-monitor picker, Translate/Extract text, Repeat region, Pick color, Measure — plus a delay selector (off / 3s / 5s / 10s) and buttons for Open image, Settings, and Upload history.

## Editor toolbar

Left to right, with default shortcuts:

| Tool | Shortcut | | Tool | Shortcut |
| --- | --- | --- | --- | --- |
| Select | `V` | | Numbered marker | `M` |
| Rectangle | `R` | | Crop | `C` |
| Ellipse | `E` | | Extract text (OCR) | `O` |
| Arrow | `A` | | Pick color | `I` |
| Line | `L` | | Measure | `U` |
| Freehand | `P` | | Insert image | — |
| Text | `T` | | Backdrop | — |
| Highlighter | `H` | | Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Pixelate | `X` | | Pin to screen | `Ctrl+P` |
| Spotlight | `W` | | | |

**Spotlight** dims everything outside the drawn shape(s), to a configurable darkness. **Backdrop** adds a padded gradient or solid-color background behind the screenshot, from a set of presets. **Extract text** drags a region, runs it through OCR (native Vision on macOS, native Windows.Media.Ocr on Windows, Tesseract on Linux), decodes any QR codes found in the same region, and — if enabled in Settings — translates the result, all in one popover.

## Export

From the toolbar's split export button: Copy (`Ctrl+C`), Save As… (`Ctrl+Shift+S`), Quick save (`Ctrl+S`*), Upload (`Ctrl+U`). The button remembers your last choice as its default action. Export size can be scaled to 100/75/50/33% of native resolution.

\* Quick save's keyboard shortcut is currently non-functional — see [Known limitations](../README.md#known-limitations); the toolbar button works.

## Pin to screen

Floats the current selection as an always-on-top window, for comparing a capture against what's underneath it: drag to move, scroll wheel to resize, `Esc` to close.

## Settings

- **General** — capture and editor defaults
- **Shortcuts** — rebind any global hotkey, including the ones unbound by default (repeat-region, pick-color, measure)
- **Output** — save folder, image format, JPEG quality, export scale
- **Appearance** — theme (system / light / dark)
- **Translation** — target language, OCR language
- **Upload** — provider (catbox.moe, Imgur, or an S3-compatible bucket) and its credentials
