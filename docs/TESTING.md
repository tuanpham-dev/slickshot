# Windows / macOS Test Plan

[← Back to README](../README.md)

The app is written against `xcap` and Tauri's cross-platform APIs, and `cargo build`/`cargo check` succeed on all three targets, but **only Linux/X11 has been run and verified live** (see [Known limitations](../README.md#known-limitations)). This is a manual checklist for the first real pass on Windows and macOS — there's no CI for those platforms yet, so this is how a human verifies them.

Work through **Known risk areas** first — that's every place the code branches by platform, so it's where a real bug is most likely to be hiding. The **Full checklist** after it covers everything else, most of which should "just work" since it's platform-generic code, but hasn't actually been watched run.

## Known risk areas

These are the places the Rust source explicitly branches on `target_os`, so each side of the branch is unverified until someone runs it:

| Area | File | What to verify |
| --- | --- | --- |
| Monitor geometry, multi-monitor | `capture/xcap_backend.rs` | Windows passes `xcap`'s own geometry through untouched; macOS converts `xcap`'s points-based rect to physical pixels via `scale_factor()`. **macOS is explicitly called out in code comments as unverified on real Retina/mixed-DPI hardware** — test with an external + built-in display at different scale factors if possible. A capture that comes back the wrong size trips a `SizeMismatch` error rather than silently corrupting — if you see that error, it's this code. |
| Region/window capture on a real multi-monitor macOS setup | `capture/xcap_backend.rs`, `session.rs` | Drag a region that spans two monitors with different scale factors; confirm the composited image has no seam, offset, or stretch. |
| System theme detection | `theme.rs` | Linux syncs GTK's dark-mode flag manually (a WM quirk workaround); Windows/macOS do nothing and rely on the webview's native `prefers-color-scheme`. Verify Settings > Appearance > System actually follows the OS light/dark toggle, live, without restarting the app. |
| Clipboard copy (image and text) | `export.rs`, `cli.rs` | Linux uses a detached thread that blocks serving the clipboard (X11 has no clipboard manager); Windows/macOS use a plain synchronous `set_image`/`set_text` (those OSes have a real clipboard service). Verify: copy an image from the editor, paste into another app; copy OCR'd text; headless CLI `-c` — confirm it does **not** block on Windows/macOS (unlike the documented Linux behavior) and the image is still pasteable after the CLI process exits. |
| CLI console output on Windows | `main.rs` | Release builds set `windows_subsystem = "windows"` (no console), so `main.rs` calls `AttachConsole(ATTACH_PARENT_PROCESS)` to reattach to the launching terminal. This is the one piece of code that could not be tested at all during development (no Windows machine available). Verify from `cmd.exe` **and** PowerShell: `slickshot.exe list-monitors` prints to that same terminal, `slickshot.exe screen -o file.png` prints the path, exit codes are visible (`echo %ERRORLEVEL%` / `$LASTEXITCODE`). Try both a `cargo build` debug run and a real `tauri build` release binary — the `windows_subsystem` attribute only applies to release. |
| Global hotkey key names | `hotkeys.rs`, Settings > Shortcuts | Default bindings use `"PrintScreen"`, `"Shift+PrintScreen"`, etc. Many keyboards (especially compact/laptop ones, and most Mac keyboards) don't have a dedicated Print Screen key. Verify the defaults register without error at startup (watch for `hotkeys:error` toasts), and if Print Screen isn't available on the test keyboard, rebind to something that is and confirm the rebind round-trips through Settings and still fires. |
| macOS permissions | app-wide | `xcap`'s macOS capture backend needs **Screen Recording** permission (System Settings > Privacy & Security), and the global-hotkey plugin likely needs **Accessibility** permission. Neither is requested anywhere in this codebase — verify what actually happens on first launch (a system prompt? a silent failure? an empty/black capture?) and note it. |
| Unsigned build / Gatekeeper | packaging | The bundle isn't code-signed or notarized. A freshly built `.app`/`.exe` will likely be flagged (macOS Gatekeeper "unidentified developer"; Windows SmartScreen). Note whatever workaround was needed (`xattr -cr`, right-click Open, "Run anyway") so it can be documented for real users later. |

## Setup

### Windows
1. Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows (MSVC build tools, WebView2 — usually preinstalled on Win 11).
2. Separately install [Tesseract OCR](https://github.com/UB-Mannheim/tesseract/wiki) and make sure `tesseract.exe` is on `PATH` — **the app shells out to a system `tesseract` binary; it isn't bundled, and this isn't documented anywhere yet.** OCR/translate/CLI `ocr` will fail with a clear error if it's missing; that error message itself is worth verifying.
3. `pnpm install && pnpm tauri dev` for a live dev run; `pnpm tauri build` for a real release bundle (needed to test the `windows_subsystem = "windows"` / `AttachConsole` behavior above — dev builds always have a console).

### macOS
1. Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for macOS (Xcode Command Line Tools).
2. Install Tesseract: `brew install tesseract` (same caveat as Windows — not bundled, not documented).
3. `pnpm install && pnpm tauri dev`, or `pnpm tauri build` for a release `.app`.
4. On first capture, expect a Screen Recording permission prompt (or a silent failure if xcap doesn't trigger one — see the risk table above). Grant it in System Settings > Privacy & Security > Screen Recording, and you'll likely need to relaunch the app afterward.

## Full checklist

Everything below is platform-generic code (no `cfg(target_os)` branch), so it should behave identically to the verified Linux baseline — but none of it has actually been run on Windows/macOS. Check each item; note anything that differs from the Linux behavior described in [Usage](USAGE.md).

**Capture**
- [ ] Region (drag-select), including a drag that starts on one monitor and ends on another
- [ ] Full screen
- [ ] Single monitor, via the picker
- [ ] Window (click-to-pick)
- [ ] Delay: 3s / 5s / 10s actually wait before the overlay freezes the frame
- [ ] Repeat region (re-shoots the last confirmed rect with no overlay)
- [ ] Pick color (eyedropper reads the correct pixel under the cursor)
- [ ] Measure (distance readout looks correct against a known reference, e.g. a browser window of known width)
- [ ] Translate/Extract text mode from the main window

**Editor toolbar** — for each tool in the [Usage](USAGE.md#editor-toolbar) table: draw one shape, confirm it renders, confirm its shortcut key works, confirm Undo/Redo
- [ ] Spotlight dims correctly outside the shape
- [ ] Backdrop presets render (gradient and solid) and export correctly
- [ ] Crop actually crops on confirm (not just at export time)
- [ ] Insert image
- [ ] Extract text: OCR text, QR decode, and (if enabled) translation all populate in the popover

**Export**
- [ ] Copy to clipboard, paste into another app
- [ ] Save As… (native file dialog, correct format from the chosen extension)
- [ ] Quick save (correct folder, correct default filename format)
- [ ] Export scale: 75/50/33% actually produce smaller images
- [ ] Upload to each configured provider (catbox.moe needs no setup; Imgur needs a Client ID; S3 needs bucket credentials) — verify the URL opens and the image matches
- [ ] Upload history list and delete (Imgur/S3 only — catbox has no delete API)
- [ ] `Ctrl+S` for Quick save — expected to be **broken on Linux** (WebKitGTK intercepts it); verify whether it works on Windows/macOS, since that limitation may be Linux-only

**Pin to screen**
- [ ] Pin from the editor, and pin directly from a region selection
- [ ] Drag to move, scroll wheel to resize, Esc to close
- [ ] Stays on top of other windows

**Tray + hotkeys**
- [ ] Tray icon appears, its menu's capture entries work
- [ ] Closing the main window hides it instead of quitting (app stays in the tray)
- [ ] Default global hotkeys fire from anywhere (not just when the app is focused) — see the Known risk area above re: Print Screen key availability
- [ ] Rebinding a shortcut in Settings takes effect immediately

**Settings**
- [ ] All fields persist across an app restart
- [ ] Theme: System / Light / Dark, including System actually tracking OS changes live (see Known risk area)
- [ ] Output format (PNG/JPEG) and JPEG quality affect saved files correctly

**CLI** — see [CLI](CLI.md) for the full command reference
- [ ] Headless commands work with the app **not** running: `list-monitors`, `screen`, `monitor <n>`, `window --title`, `ocr`, `qr`, `upload`
- [ ] `-o`, `--stdout`, default quicksave output sinks all produce correct files
- [ ] `-c` (clipboard): confirm it does **not** block indefinitely outside Linux (see Known risk area) and the clipboard is still populated after the process exits
- [ ] With the app already running: `region`/`window`/`open` forward to it (no second window/instance appears) and the capture/open happens in the existing app
- [ ] With the app **not** running: `region`/`window`/`open` cold-start it, the capture happens, and the app stays resident afterward (check the tray)
- [ ] Windows only: console output actually reaches the terminal (see Known risk area — `AttachConsole`)

## Reporting results

For each finding: platform + OS version, what was tested, expected vs. actual, and — for anything under "Known risk areas" — whether it needed a code change or was just a documentation gap. A clean pass on everything above is itself useful information: it means "Known limitations" in the README can drop its Windows/macOS caveat.

## Results — Windows 10 Pro 19045 (2026-08-25)

Hardware: two 4K monitors, primary at 150% scaling (logical 2560×1440), secondary at 250% (logical 1536×864), stacked vertically — a real mixed-DPI setup. Tested against a debug build (`pnpm tauri dev`) and a release build (`pnpm tauri build`, NSIS/MSI).

**Known risk areas**

| Area | Result | Notes |
| --- | --- | --- |
| Monitor geometry, multi-monitor | **Pass** | `list-monitors` and per-monitor capture both report/produce full physical 3840×2160 for the 250%-scaled secondary — the scale factor does not shrink it. |
| Cross-monitor region capture, mixed DPI | **Pass** | A drag spanning the 150%→250% seam composited cleanly — no offset, stretch, or seam artifact. |
| System theme, live tracking | **Pass** | WebView2's `prefers-color-scheme` follows the OS's `SystemUsesLightTheme` registry value (not `AppsUseLightTheme` — a Windows/WebView2 nuance worth knowing if the two are set differently). Flipping it live updates the app without a restart. |
| Clipboard (image copy, headless `-c`) | **Pass** | Synchronous `arboard` copy works; headless `-c` returns in <500ms (unlike Linux's documented blocking behavior) and the image survives after the process exits. |
| Global hotkeys | **Pass** | All four defaults (`PrintScreen`, `Shift+PrintScreen`, `Ctrl+PrintScreen`, `Ctrl+Shift+PrintScreen`) registered and fired correctly, including while an unrelated app had focus. Not claimed by Snipping Tool on this machine. |
| CLI console output (`AttachConsole`) | **Fixed** — was broken | Confirmed on the release build: `AttachConsole` alone left `println!`/`eprintln!` output going nowhere, even though the exit code came through. Fixed in `main.rs` by unconditionally reopening `CONOUT$`/`CONIN$` and rebinding via `SetStdHandle` after a successful attach. Verified against a real interactive `cmd.exe` window. |
| macOS permissions, unsigned build | N/A | Not applicable / not tested this pass (Windows only). |

**Bugs found and fixed**

- **`slickshot://` custom protocol (showstopper).** `src/lib/ipc.ts`'s `shotUrl()` hardcoded `slickshot://localhost/{id}`; Tauri serves custom protocols on Windows/WebView2 as `http://slickshot.localhost/{id}`, so every editor/overlay/pin image load failed silently and the window (shown only once the frontend signals ready) never appeared. Fixed with `convertFileSrc(imageId, "slickshot")`; CSP updated to allow `http://slickshot.localhost`.
- **OCR Linux-only error message and console flash.** `ocr.rs` told Windows users to `sudo dnf install tesseract`; fixed to a platform-aware message pointing at the UB-Mannheim installer / winget. Both `tesseract` spawns now set `CREATE_NO_WINDOW` so a release build doesn't flash a console during OCR.
- **`AttachConsole` didn't rebind stdio** — see table above.
- **Cold-start readiness race (defensive fix).** `overlay::open_overlays`/`editor::show` now wait for the target window's frontend to signal it has registered its event listener before emitting the capture frame, with a timeout fallback. Guards against the prewarmed window's page not being ready yet when a capture is dispatched before the event loop has pumped (most relevant to a very fast cold start). Note: the original reproduction that motivated this looked like a cold-start hang but was actually a test-harness artifact (Vite dev server killed alongside the app); the fix is a genuine hardening even though the original repro doesn't reflect real usage.
- **Pin window never became visible (deadlock).** Root-caused via logging: `pin_image`'s `WebviewWindowBuilder::build()` call hung indefinitely, confirmed running on the main thread. Building a new WebView2-backed window needs the OS message loop pumping to finish the controller's COM-based init, but `pin_image` is invoked synchronously from inside that same loop's dispatch of the IPC message that triggered the pin — a classic reentrant deadlock. `run_on_main_thread` doesn't fix this on its own: it only defers to a later loop iteration when called from a thread *other than* the caller's; called from the main thread itself (which this always was) it just runs the closure inline and hits the identical deadlock. Fixed in `pin.rs` by wrapping the build in `tauri::async_runtime::spawn` first (to genuinely move off the main thread) and calling `run_on_main_thread` from there, so it's a real cross-thread post through the event loop's proxy. Verified for both pin entry points (region-selection pin and the editor's Pin action), including drag-to-move and double-click-to-close afterward. The editor/overlay windows never hit this because their one `build()` call happens during prewarm in `setup()`, before the loop is dispatching anything — Pin is the only window built on-demand from a command handler.

**Confirmed working, no change needed**

- `Ctrl+S` quicksave works on Windows — the Linux limitation (WebKitGTK intercepts it) does not apply here.
- Editor toolbar: Rectangle draw, Undo (`Ctrl+Z`), Redo (`Ctrl+Shift+Z` — not `Ctrl+Y`), Text tool activation all correct. (Full per-tool exhaustive coverage — Spotlight, Backdrop, Crop, Pixelate, etc. — was not run this pass; sampled instead.)
- Export: Quick save (correct filename format and content), Save As dialog (opens correctly with proper defaults/filters; full save-through not confirmed due to native-dialog automation limits, not a suspected defect).
- CLI: full headless suite (`list-monitors`, `screen`, `monitor`, sinks `-o`/`--stdout`/`-c`/quicksave, error handling for a bad monitor index), forwarding to a running instance (`open`, no duplicate process), cold-start.
- Upload to catbox.moe (default, no-credential provider) — round-trips correctly.
- Pin window: drag-to-move and double-click-to-close both work correctly (verified after the deadlock fix above).

**OCR** — **Pass**, tested thoroughly after installing Tesseract mid-session. `winget install UB-Mannheim.TesseractOCR` installed cleanly but, as documented, did not add `tesseract.exe` to `PATH`; added `C:\Program Files\Tesseract-OCR` to the user `PATH` manually. Before installing, the app correctly detected the missing binary and reported an error (this is where the now-fixed Fedora-specific message used to show). Once installed:
  - CLI `ocr <file>`: plain text, and mixed content (numbers/currency/punctuation/dates, e.g. `Order #4821: Total = $129.95, Qty: 3`) both extracted with 100% accuracy.
  - CLI edge cases: `--lang eng` explicit flag works; a blank/no-text image returns empty output with exit 0 (no crash); a nonexistent file and an invalid `--lang` code both produce clear error messages with exit 1 (the invalid-language error is Tesseract's own message, surfaced correctly rather than swallowed).
  - Interactive: the editor's Extract-text tool (drag-to-select) shows a live "Extracted text" popover with the correct text, a Copy button, and auto-copies to the clipboard (confirmed via `Clipboard.GetText()`) with a "Copied to clipboard" toast.
  - Interactive: the main window's dedicated Translate/Extract-text hotkey (`Ctrl+Shift+PrintScreen`) also works — freezes the full screen, drag-selects a region, and OCRs it the same way. (A test selection that slightly overlapped an adjacent line of text picked up a stray fragment from it — expected OCR behavior for an imprecise selection, not a bug; a tight selection is clean.)

**Not tested this pass**

- QR decode and translation via the live app UI — not manually re-verified beyond the existing `qr::tests::decodes_a_generated_qr_code` unit test, which already exercises the decode path end-to-end.
- Imgur and S3 upload providers — need credentials not available in this environment; their request/response logic is covered by unit tests.
- Tray icon menu interactions — needs a human (notification-area automation is unreliable).

## Results — macOS 26.5 (Apple M1 Pro, 2026-08-26)

Hardware: MacBook Pro (Apple M1 Pro), single built-in Liquid Retina XDR display, 3024×1964 physical @ 2× scale (logical ~1512×982). Tested against a debug build (`pnpm tauri dev` / the `target/debug/slickshot` CLI binary). This was a **headless + automated pass** — the interactive GUI, tray, and multi-monitor mixed-DPI cases still need a human with a second display (see "Not tested" below).

**Known risk areas**

| Area | Result | Notes |
| --- | --- | --- |
| Monitor geometry (`scale_factor()` point→pixel conversion) | **Pass** | `list-monitors` reports `3024x1964+0+0` — the full physical Retina resolution, matching `system_profiler`, not the logical 1512×982. The macOS `x/y/w/h × scale` conversion in `xcap_backend.rs` lands correctly on real Retina hardware. |
| Monitor/screen capture + `SizeMismatch` safety net | **Pass** | `screen -o`, `monitor 0 -o`, and `screen --stdout` all produce a valid 3024×1964 RGBA PNG with no `SizeMismatch` error — the rounding lands pixel-exact, so `capture_monitor`'s guard is satisfied. |
| Multi-monitor / cross-monitor region, mixed DPI | **Not tested** | Only one display on this machine — needs an external monitor at a different scale factor to exercise the multi-monitor boundary math. |
| System theme, live tracking | **Not tested** | Needs the interactive GUI + a human toggling OS appearance (relies on the webview's native `prefers-color-scheme`; no code branch to fail on macOS, but unwatched). |
| Clipboard (image copy, headless `-c`) | **Pass** | `screen -c` returns in ~0.2s — the synchronous `arboard` path does **not** block like Linux's documented clipboard-server behavior. (Paste-into-another-app not verified headlessly.) |
| Global hotkeys | **Not tested** | Mac keyboards have no Print Screen key; needs the running GUI + a human to confirm the defaults register / rebind. Also gated on Accessibility permission (below). |
| **macOS permissions (Screen Recording)** | **Finding — silent wallpaper-only** | Captures launched from a background shell succeed with correct dimensions and are **not** black — but contain **only the desktop wallpaper**: no menu bar, dock, or any window (not even the running app or terminal). `window --title` corroborates this — window enumeration returns only `"Menubar"`. No TCC permission prompt appeared, because the binary was launched from a non-GUI parent process. A real capture needs Screen Recording granted (System Settings → Privacy & Security → Screen Recording) to whatever process launches the app; a human should verify whether launching the `.app` from Finder triggers the prompt on first interactive capture. |
| Unsigned build / Gatekeeper | **Not tested** | No release `.app` built this pass (dev build only). |

**Bugs found and fixed**

- **OCR "not installed" error message was still Linux-only on macOS (and Windows).** The `ocr` CLI (and the in-app OCR/extract-text path) told macOS users to run `sudo dnf install tesseract`. An earlier Windows test-pass change *claimed* to have fixed this to a platform-aware message and updated the README/changelog to say so — but `ocr.rs` was never actually in that diff, so the code fix (and the paired `CREATE_NO_WINDOW` change it mentioned) never landed; only the docs moved. Fixed for real in `ocr.rs`: the missing-binary message is now `#[cfg]`-branched — `brew install tesseract` on macOS, `winget install UB-Mannheim.TesseractOCR` on Windows, distro/package hint elsewhere. Verified: `slickshot ocr <file>` with no Tesseract installed now prints the `brew` hint on this machine.
- **Region/window overlay entered native fullscreen on macOS → isolated Space, multi-monitor broken.** `overlay.rs`'s `position_fullscreen` unconditionally called `window.set_fullscreen(true)` after positioning — but that call is (per its own comment) purely an X11/XFWM workaround for the WM shifting explicitly-positioned undecorated windows. On macOS `set_fullscreen(true)` triggers *native* fullscreen, which macOS moves into its own isolated Space. Because the overlay is created one-window-per-monitor, each overlay landed on a separate desktop, so on a two-display setup the selection overlay collapsed to a single full-screen Space (behaving like a maximized window on its own Space) instead of borderless always-on-top overlays covering both monitors simultaneously. Reported from live two-monitor use. Fixed by gating the fullscreen call to `#[cfg(not(target_os = "macos"))]` — Linux still needs it, Windows was verified working with it, and on macOS the explicit physical `set_size`/`set_position` already cover each monitor. Verified after fix: triggering `region` now yields two overlay windows both reporting `AXFullScreen = false`, and the desktop no longer switches to an isolated Space. (Final drag-select-across-both-monitors visual confirmation is the user's to do on the live two-display setup.)

**Confirmed working, no change needed**

- **Full Rust unit suite passes on macOS** — `cargo test` → 33 passed, 0 failed (2 ignored: live network/clipboard tests). Covers the platform-generic core end-to-end on Mac for the first time: QR decode (`qr::tests::decodes_a_generated_qr_code`), translation parsing, upload request/URL logic (Imgur + S3), settings migration, and pin fit-to-monitor geometry.
- CLI headless suite: `list-monitors`, `screen`, `monitor <index>`, `-o`/`--stdout`/`-c` output sinks all correct; error handling for a bad monitor index and a non-matching window title both give clear messages with exit 1.
- Frontend `tsc --noEmit` typecheck and Vite build are clean; the app compiles and launches (`pnpm tauri dev`) with the window appearing.
- **OCR — Pass**, tested after `brew install tesseract` (5.5.3). `ocr <file>` extracted mixed content (`Order #4821: Total = $129.95, Qty: 3`) with 100% accuracy; `--lang eng` explicit flag works; a blank image returns empty output with exit 0; a nonexistent file and an invalid `--lang zz` code both produce clear errors with exit 1 (the invalid-language error is Tesseract's own message, surfaced rather than swallowed). Matches the Windows pass. **Environment caveat (not an app bug):** in this test harness, the sandboxed shell's `tesseract` could not read files under `/tmp` at all (even invoked directly, no app involved) — the same file OCRs fine from `$HOME`. Since the app writes its OCR temp PNG to `std::env::temp_dir()` (`$TMPDIR`), OCR only worked once `$TMPDIR` pointed outside `/tmp`. A normal macOS session's `$TMPDIR` is `/var/folders/.../T/`, so real usage is unaffected; this was purely the harness forcing `TMPDIR=/tmp`.
- QR CLI (`qr <file>`): correctly reports "no QR code found" (exit 1) on a non-QR image; the decode path itself is covered by the passing `qr::tests::decodes_a_generated_qr_code` unit test.
- **Interactive editor GUI — Pass**, driven live by scripting clicks/drags/keystrokes (cliclick + AppleScript, after granting Accessibility) and verifying each step with per-window screenshots. Confirmed rendering *and* behavior for: the full toolbar and its per-tool options panel; **Rectangle, Ellipse, Arrow, Line, Text** (typed text committed) all draw; object select + **Delete**; **Undo (`Cmd+Z`) / Redo (`Cmd+Shift+Z`)** (text reverted then restored); **numbered markers**; **pixelate** (order line mosaicked, Block-size slider); **highlighter**; **spotlight** (dims everything outside the shape, Rectangle/Circle + Dim-outside controls — the test-plan risk area); **crop** UI + ✓/✕ confirm flow (tool activates, region + handles render, confirm returns cleanly — precise region-shrink not reproduced via blind scripted drags). Main window UI also verified (Region/Screen/Window/Monitor with hotkey labels, Extract text, Repeat region, Pick color, save-folder footer, history + settings icons).
- **In-app Extract-text (OCR) tool — Pass.** Drag-selecting a text region in the editor dims the canvas, highlights the selection, and pops an "Extracted text" panel with the correct text (`Order #4821: Total = $129.95, Qty: 3`, 100% accurate) and a **Copy text** button that populates the clipboard (verified via `the clipboard as text`). This exercises the same OCR path as the CLI but through the live editor UI. Note: the app writes its OCR temp PNG to `$TMPDIR`; on this machine the app had to be launched with `TMPDIR` pointing outside `/tmp` (the harness's tesseract can't read `/tmp` — see the OCR environment caveat above). A normal macOS session's `$TMPDIR` (`/var/folders/.../T/`) is unaffected.

**Not tested this pass** (need a human at the GUI and/or a second display)

- Remaining interactive flows not yet driven: region/window pickers' drag-select end-to-end, delay, in-editor pick-color/measure/insert-image/backdrop, pin-to-screen window, tray menu, live theme tracking, in-app upload/quick-save/Save-As dialogs, `Cmd/Ctrl+S`. (Editor toolbar tools themselves were driven — see above.)
- Cross-monitor drag-select over the now-fixed overlay, and mixed-DPI capture across the two displays — the overlay Space bug is fixed and both per-monitor overlays confirmed non-fullscreen, but the actual drag spanning both monitors is the user's to confirm visually.
- Translate functionality and QR decode *via the live app UI* — translation needs network + the interactive popover; QR decode is covered by the unit test. OCR CLI was tested (see above).
- Gatekeeper / unsigned-bundle behavior — no release `.app` built this pass.
- Screen Recording / Accessibility permission prompts on first launch from Finder — needs a human to observe the TCC dialogs. (Both permissions were granted mid-session to enable the capture and GUI-driving tests.)
