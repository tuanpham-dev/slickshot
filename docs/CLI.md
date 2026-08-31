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
| `slickshot open <file>` | Open an existing image in the annotation editor. |
| `slickshot ocr <file> [--lang <code>]` | Extract text (native Vision on macOS, native Windows.Media.Ocr on Windows, Tesseract on Linux); prints to stdout. |
| `slickshot qr <file>` | Decode QR codes; one payload per line. |
| `slickshot upload <file>` | Upload to the configured host; prints the URL. |
| `slickshot list-monitors` | List monitor index, id, and geometry. |

Capture commands (`screen`, `monitor`, `window`, `region`, `scroll`) share output flags:

- `-o, --output <path>` — save to a file (format inferred from `.png`/`.jpg`/`.jpeg`)
- `-c, --clipboard` — copy to the clipboard
- `--stdout` — write the encoded PNG to stdout (headless commands only — not supported on `region`/`window`, which forward to a separate process before the capture happens)
- `--edit` — open the annotation editor instead of exporting directly (`region`/`window` only)
- Scrolling capture takes as long as the page does; `-o` receives the stitched image once it ends, either at the bottom of the page or when you press Done on its control pill.
- `--delay <ms>` — wait before capturing; the CLI process sleeps this locally, so the shell prompt returns once the capture actually starts

With none of `-o`/`-c`/`--stdout`/`--edit` set, a capture is **quick-saved** to the configured save folder (same default as the app's own Quick Save), and the CLI prints the path.

```
slickshot screen -o ~/Pictures/shot.png
slickshot monitor 0 --stdout | xclip -selection clipboard -t image/png
slickshot region --edit          # drag a region, then annotate it
slickshot window --title firefox -c
slickshot scroll -o ~/Pictures/long-page.png
```

On Linux, `-c` blocks the CLI process until another application takes ownership of the clipboard (X11 has no independent clipboard service) — Ctrl+C to stop serving it once you've pasted.
