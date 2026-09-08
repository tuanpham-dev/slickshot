# CLI

[← Back to README](../README.md)

The same binary doubles as a CLI. Non-interactive commands run headless (no window ever opens) and work whether or not the app is already running; `region`/`scroll`/`window`/`open` are interactive — they forward to a running instance, or launch one, and the app stays resident in the tray afterwards.

| Command | Behavior |
| --- | --- |
| `slickshot screen` | Capture the full virtual screen, headless. |
| `slickshot monitor <index>` | Capture one monitor by index (see `list-monitors`), headless. |
| `slickshot window --title <substring>` | Capture the first window whose title matches, headless. |
| `slickshot window` | Interactive window picker (opens the overlay). |
| `slickshot region` | Interactive region selection (opens the overlay). |
| `slickshot scroll` | Pick a region or a window, then auto-scroll the content under it and stitch the frames into one long screenshot. |
| `slickshot record` | Pick a region or a window, then record it to an MP4 until stopped. |
| `slickshot probe <file>` | Print a recording's dimensions, duration, frame rate and audio tracks. |
| `slickshot open <file>` | Open an existing image in the annotation editor. |
| `slickshot ocr <file> [--lang <code>]` | Extract text (native Vision on macOS, native Windows.Media.Ocr on Windows, Tesseract on Linux); prints to stdout. |
| `slickshot qr <file>` | Decode QR codes; one payload per line. |
| `slickshot upload <file>` | Upload to the configured host; prints the URL. |
| `slickshot list-monitors` | List monitor index, id, and geometry. |

Capture commands (`screen`, `monitor`, `window`, `region`, `scroll`, `record`) share output flags:

- `-o, --output <path>` — save to a file (format inferred from `.png`/`.jpg`/`.jpeg`)
- `-c, --clipboard` — copy to the clipboard
- `--stdout` — write the encoded PNG to stdout (headless commands only — not supported on `region`/`window`, which forward to a separate process before the capture happens)
- `--edit` — open the annotation editor instead of exporting directly (`region`/`window` only)
- Scrolling capture takes as long as the page does; `-o` receives the stitched image once it ends, either at the bottom of the page or when you press Done on its control pill.
- `--delay <ms>` — wait before capturing; the CLI process sleeps this locally, so the shell prompt returns once the capture actually starts

`record` takes three more:

- `--duration <seconds>` — stop automatically instead of waiting for Stop on the pill. This is what makes recording scriptable
- `--audio <sources>` — `system`, `mic`, or both comma-separated (macOS only). Omitting the flag leaves the saved settings and the overlay's own toggles alone; passing it overrides them for this run
- `--fps <n>` — frame rate for this run, overriding the setting

`-c`/`--clipboard` and `--stdout` are rejected for `record`: there is no
still image to put anywhere, and a recording's bytes are not something a
terminal should receive. Use `-o`.

`probe` takes `--track-offsets`, which prints each audio track's first and
last sample time and the skew between two — a diagnostic for microphone
drift, not something a normal run needs.

With none of `-o`/`-c`/`--stdout`/`--edit` set, a capture is **quick-saved** to the configured save folder (same default as the app's own Quick Save), and the CLI prints the path.

```
slickshot screen -o ~/Pictures/shot.png
slickshot monitor 0 --stdout | xclip -selection clipboard -t image/png
slickshot region --edit          # drag a region, then annotate it
slickshot window --title firefox -c
slickshot scroll -o ~/Pictures/long-page.png
slickshot record --duration 10 -o ~/Videos/demo.mp4
slickshot record --duration 10 --audio system,mic -o ~/Videos/narrated.mp4
slickshot probe ~/Videos/demo.mp4
```

GIF output from the CLI is not wired up yet — `record -o demo.gif` is
refused rather than silently writing an MP4 with the wrong extension.
Record to `.mp4` and export the GIF from the video editor.

On Linux, `-c` blocks the CLI process until another application takes ownership of the clipboard (X11 has no independent clipboard service) — Ctrl+C to stop serving it once you've pasted.
