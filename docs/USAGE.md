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

## Recording

Record screen takes a region or a window and writes an MP4. The overlay is the
same one region capture uses, with two extra toggles on macOS for system audio
and the microphone; the first time the microphone is used the OS asks for
permission, and a denial is reported on the pill rather than producing a
silently silent file.

Once the region is confirmed the overlays come down and a pill appears below it
with a running clock, a Stop and a Cancel. Stop keeps the recording and hands
it to whatever "After capture" is set to; Cancel throws it away. A recording
has to fit on one monitor — a region dragged across two is refused with an
explanation.

Frame rate, cursor visibility and the audio defaults live in Settings >
Recording, along with how many recordings capture history keeps (counted
separately from screenshots, since each one is orders of magnitude larger).

## Video editor

A finished recording opens here. It streams rather than loading whole, so
seeking in a long clip is immediate.

**The timeline** runs along the bottom: click anywhere to seek, drag either
handle to trim. The excluded ranges dim, and the duration under the clip shows
what the export will actually be — including the speed change.

**Speed** is 0.5x to 4x, applied to both preview and export. On macOS the audio
is time-stretched with pitch correction, so a 2x clip still sounds like speech;
the other platforms export silent video at any speed but 1x.

**The tools** are the image editor's, minus the ones that read pixels from a
still frame (eyedropper, extract text, loupe, measure) — those have no meaning
against a clip whose pixels change under them. Crop marks the region to export
rather than re-encoding as you drag it. Censors are the one annotation that is
not flattened into a single overlay image: they are re-applied to every frame,
because a censor baked from one paused frame would show that frame's pixels
forever while the video moved underneath it.

**The export bar** mirrors the image editor's: Show in folder, Copy file,
Upload, Discard, Save As and Quick save, with MP4 or GIF chosen next to the
speed control. Copy file puts the *file* on the clipboard rather than its
contents — pasting into Finder or Explorer makes a copy, pasting into a message
attaches it — and it exports the trim first, so what you copy is what you would
have saved. Upload is hidden for hosts that reject video (imgur, imgbb).

GIFs are capped to the max width in Settings and have no sound.

## Pin to screen

Floats the current selection as an always-on-top window, for comparing a capture against what's underneath it: drag to move, scroll wheel to resize, `Esc` to close.

## Settings

- **General** — capture and editor defaults
- **Shortcuts** — rebind any global hotkey, including the ones unbound by default (repeat-region, pick-color, measure)
- **Output** — save folder, image format, JPEG quality, export scale
- **Appearance** — theme (system / light / dark)
- **Translation** — target language, OCR language
- **Upload** — provider (catbox.moe, Imgur, or an S3-compatible bucket) and its credentials
