# SlickShot

A multi-platform screenshot capture and annotation tool built with Tauri 2 + React.

**Website:** <https://tuanpham-dev.github.io/slickshot/> - the source lives in [`site/`](site/) and is published by [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push to `main` that touches it.

## Features

- **Capture modes:** region (drag-select, can span monitors), full screen, single monitor, window, repeat last region, pick a color off the screen, measure a distance, and translate/extract text from a dragged region
- **Delay:** off / 3s / 5s / 10s
- **Annotation editor toolbar:** select, rectangle, ellipse, arrow, line, freehand, text, highlighter, pixelate, spotlight (dim everything outside a shape), numbered markers, crop, extract text (OCR), pick color, measure — plus insert image and a gradient/solid-color backdrop — all with undo/redo
- **Text extraction:** drag a region to OCR it (native **Vision** on macOS, native **Windows.Media.Ocr** on Windows, **Tesseract** on Linux), decode any QR codes in the same region, and optionally translate the result — from the toolbar's Extract-text tool, the main window's Translate/Extract-text mode, or the CLI's `ocr`/`qr` commands
- **Export:** copy to clipboard, Save As, Quick save to a configured folder, or upload to Imgur / an S3-compatible bucket / catbox.moe (with local upload history and one-click delete for providers that support it); export size can be scaled to 100/75/50/33%
- **Pin to screen:** float a region as an always-on-top window — drag to move, scroll to resize, Esc to close — for comparing a capture against what's underneath it
- **Open existing images** for annotation
- **CLI** — capture, OCR, decode QR, and upload from the terminal; see [docs/CLI.md](docs/CLI.md)
- **Tray icon + global hotkeys**, all rebindable in Settings > Shortcuts (default: `PrintScreen` region, `Shift+PrintScreen` screen, `Ctrl+PrintScreen` window, `Ctrl+Shift+PrintScreen` translate/extract text; repeat-region, pick-color, and measure are unbound by default)
- **Settings** persisted across restarts: shortcuts, save folder, output format/quality/scale, theme, translation target language, OCR language, upload provider and credentials

## Documentation

- [Usage](docs/USAGE.md) — main window, editor toolbar and shortcuts, export options, Pin to screen, Settings reference
- [CLI](docs/CLI.md) — capture, OCR, QR, and upload from the terminal
- [Architecture](docs/ARCHITECTURE.md) — how capture, coordinate handling, the editor, IPC, and the CLI are built
- [Windows / macOS Test Plan](docs/TESTING.md) — manual verification checklist for the two untested platforms
- [Building](docs/BUILDING.md) — release bundles, and the AppImage build's known issues + fix

## Prerequisites (Linux / Fedora)

```
sudo dnf install -y librsvg2-devel pipewire-devel clang-devel mesa-libgbm-devel
```

- `librsvg2-devel` — icon generation (`tauri icon`)
- `pipewire-devel` — `xcap`'s Linux backend links PipeWire (used for its Wayland portal path, even though this app currently only implements the X11 capture path)
- `clang-devel` — provides `libclang.so`, needed by `bindgen` (a transitive dependency via the PipeWire bindings)
- `mesa-libgbm-devel` — `libgbm`, pulled in by `xcap`'s Wayland/DRM support path

Building the **AppImage** bundle also needs `patchelf` (`sudo dnf install patchelf`) — see [Building](docs/BUILDING.md) for that and a couple of other AppImage-specific build quirks.

Other platforms need their standard [Tauri prerequisites](https://tauri.app/start/prerequisites/).

**OCR (used by extract-text/translate/the `ocr` CLI command):**

- **macOS** uses the built-in **Vision** framework and **Windows** uses the built-in **Windows.Media.Ocr** engine — nothing to install, no external binary on either. Recognition is on-device and covers the languages in Settings > OCR language (subject, on Windows, to the installed language packs).
- **Linux** uses **Tesseract**. The `.deb`/`.rpm` bundles declare it as a package dependency (`tesseract-ocr` + `tesseract-ocr-eng` on Debian/Ubuntu, `tesseract` + `tesseract-langpack-eng` on Fedora), so installing the app pulls it in automatically. The **AppImage** is self-contained and can't declare dependencies, so AppImage users install it themselves; when it's missing, the app dims the Extract-text/Translate entry points and offers a distro-appropriate install command (with a "Check again" to unlock OCR without restarting) instead of failing on first use.

## Development

```
pnpm install
pnpm tauri dev
```

## Building

```
pnpm tauri build
```

Bundles land in `src-tauri/target/release/bundle/` (`deb/`, `rpm/`, `appimage/`). **The AppImage bundle currently needs a follow-up step** (`pnpm fix:appimage`) after the build — see [Building](docs/BUILDING.md) for why and what it does.

## Known limitations

- **Wayland is not implemented.** The `ScreenCapturer` trait is the seam for a future `PortalCapturer` (xdg-desktop-portal) backend; the app currently only has an X11 implementation.
- **Ctrl+S in the editor** appears to be intercepted by a native WebKitGTK/GTK accelerator before it reaches the page's JavaScript — pressing it does nothing on Linux. Save As and Quick save both work correctly via the toolbar/menu; only the keyboard shortcut is affected, and only on Linux — it works on Windows.
- **macOS** builds and runs on Apple Silicon (dev build and the CI-built release bundle both verified); core capture/editor/settings functionality has been exercised, though it hasn't had the same systematic pass as the [Windows test plan](docs/TESTING.md).
- **macOS: a downloaded build says "is damaged and can't be opened."** Release builds aren't code-signed/notarized (no Apple Developer account wired into CI), so Gatekeeper rejects the quarantine flag a browser download adds — the "damaged" wording is misleading, the app isn't actually corrupted. Right-click the `.app` → Open (and confirm through the dialog), or run `xattr -cr /path/to/SlickShot.app` in Terminal.
- **Windows** has been verified live (Windows 10 Pro, mixed-DPI dual-4K-monitor setup) — see [Windows / macOS Test Plan](docs/TESTING.md#results--windows-10-pro-19045-2026-08-25) for the full results. Everything tested passed or was fixed, including a Pin-window deadlock (building its webview from inside the triggering IPC call could hang the main thread).
- **Windows: PrintScreen may be claimed by Snipping Tool or OneDrive** on some setups, preventing the default `PrintScreen` hotkey from registering; the app surfaces this via a Settings banner (`hotkeys:error`) — rebind to something else (e.g. `Ctrl+Alt+S`) in Settings > Shortcuts if that happens.
- **Windows: `cmd.exe`/PowerShell don't wait for a GUI-subsystem process by default** — running `slickshot.exe <command>` from a script that needs the exit code should use `start /wait` (cmd) or check the process object explicitly (PowerShell), since the shell prompt otherwise returns before the app finishes.
