# Building

[← Back to README](../README.md)

```
pnpm tauri build
```

Produces release bundles under `src-tauri/target/release/bundle/` — `deb/` and `rpm/` on Fedora/most Linux distros, plus an `appimage/` attempt (see below). Pass `--bundles <deb,rpm,appimage>` to build a subset, e.g. `pnpm tauri build --bundles appimage` to (re)build just one format without recompiling from scratch if `target/release` is already up to date.

## macOS: unsigned builds say "is damaged and can't be opened"

Neither `tauri.conf.json` nor the CI workflow configures code signing or notarization (that needs an active Apple Developer Program membership), so the `.app`/`.dmg` Tauri produces is only ad-hoc/linker-signed — no Team ID. That's fine for a build you compile and run yourself, since it was never downloaded and so never picked up the quarantine attribute Gatekeeper checks. But a build fetched via a browser (a CI artifact, a release download) does get quarantined, and Gatekeeper won't accept an ad-hoc signature on a quarantined app — instead of the friendlier "unidentified developer" prompt you'd get from an unsigned-but-not-quarantined app, it reports the misleading **"is damaged and can't be opened, you should move it to the Trash."** The app isn't actually corrupted.

**Fix**, either:

- Right-click (or Control-click) `SlickShot.app` → **Open** → confirm through the dialog that appears, or
- Clear the quarantine attribute directly: `xattr -cr /path/to/SlickShot.app`

Real code signing + notarization would avoid this entirely, but requires an Apple Developer account and adding signing secrets to the CI workflow.

## AppImage: known build issue and fix

As of this writing, `pnpm tauri build` (or `--bundles appimage`) reliably fails at the AppImage step with:

```
failed to bundle project: `failed to run linuxdeploy`
```

`.deb` and `.rpm` are unaffected — this is specific to the AppImage bundler. Two independent problems combine to cause it:

1. **Icon name mismatch (Tauri bundler bug).** The AppDir's icon is written as `<productName>.png` (`SlickShot.png`), but the `.desktop` file's `Icon=` key uses the sanitized binary name (`slickshot`), expecting `slickshot.png`. `appimagetool` refuses to package an AppDir whose `Icon=` target doesn't exist, and reports it as (unhelpfully) `slickshot{.png,.svg,.xpm} defined in desktop file but not found`.
2. **`linuxdeploy`'s own final packaging step fails outright.** Its bundled `appimagetool` needs `$ARCH` and `$LD_LIBRARY_PATH` set, which `linuxdeploy` doesn't appear to pass through correctly in this setup. Its error reporting collapses this to a generic `subprocess failed (exit code 127)` with no indication of what was actually missing.

Everything **before** that point — compiling, populating the AppDir, copying and RPATH-patching the GTK/WebKit shared libraries — succeeds; only the very last "assemble the `.AppImage` file" step fails.

**Fix:** after a failed build, run:

```
pnpm fix:appimage
```

This reuses the AppDir the failed build already populated, copies the icon to the name the `.desktop` file expects, then calls the bundled `appimagetool` directly (with `$ARCH`/`$LD_LIBRARY_PATH` set correctly) instead of going through `linuxdeploy`'s broken wrapper. See `scripts/fix-appimage.sh` for the exact steps — it's a plain, readable shell script, not a black box.

### If you have AppImageLauncher installed

Some systems run [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher), which registers a kernel `binfmt_misc` handler that intercepts execution of **any** AppImage file — including `linuxdeploy`'s own cached tooling that both `pnpm tauri build` and `fix-appimage.sh` invoke. On a system where it's installed, the build can **hang indefinitely** waiting for an "integrate this AppImage?" prompt that never appears in a non-interactive build (rather than failing with the error above).

If a build hangs rather than erroring, edit `~/.config/appimagelauncher.cfg` and temporarily set:

```
ask_to_move = false
enable_daemon = false
```

then stop the running daemon once (`systemctl --user stop appimagelauncherd`) so the new config takes effect, build, and restore both settings afterward (`systemctl --user start appimagelauncherd`). This is a per-machine daemon setting, not a project file — nothing here is committed to the repo.

### Missing `patchelf`

`linuxdeploy` also needs the system `patchelf` binary (used to fix shared-library RPATHs when bundling). If it's missing you'll see the same generic `subprocess failed` error even before the icon/appimagetool issues above. Install it: `sudo dnf install patchelf` (Fedora) or your distro's equivalent.

## Auto-updates: signing keys and release setup

Windows, macOS and the **AppImage** update themselves through
[`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/), polling the
`latest.json` attached to the newest GitHub release. The `.deb`, `.rpm` and
AUR packages deliberately do **not** self-update -- they belong to the user's
package manager, and the app says so in Settings > Updates instead of offering
a download.

### One-time setup

The updater only trusts artifacts signed with the private half of the keypair
whose public half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
That public key is already committed:

```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDlERkMwMzhDMzU4MjQxOQpSV1FaSkZqRE9NRGZDU1o0NnIxZmpmUVA2SHN2WksyS1JaL1ZaSkE2SXZWT0d6Tk5UT3AwNDdQWgo=
```

The matching **private key was generated outside the repository and is not
committed**. Before the first signed release, add it to the repo's GitHub
Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY` -- the contents of the private key file
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` -- its password, or an empty secret if
  the key has none

To generate a fresh keypair (only needed if the private key is lost -- note
that **already-installed copies will stop accepting updates**, since they
verify against the old public key baked into their build):

```
pnpm tauri signer generate -w ~/.slickshot-updater.key
```

Then paste the printed public key into `plugins.updater.pubkey` and update the
two Actions secrets.

### Cutting a release

Push a `v*.*.*` tag. The `build` workflow builds every platform, signs the
updater artifacts, and opens a **draft** release with `latest.json` attached.
Publishing that draft is what makes installed copies see the update, so the
release notes can be edited first.

### Verifying the update flow locally

1. Build and install the current version.
2. Bump `version` in `src-tauri/tauri.conf.json`, rebuild, and sign the
   artifacts with the same key.
3. Serve a `latest.json` pointing at those artifacts (`python3 -m http.server`
   is enough) and temporarily point `plugins.updater.endpoints` at it.
4. Launch the installed copy and use Settings > Updates > Check for updates.
