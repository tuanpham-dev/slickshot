#!/usr/bin/env bash
# Finishes the AppImage bundle after `pnpm tauri build` (or
# `pnpm tauri build --bundles appimage`) fails with:
#   failed to bundle project: `failed to run linuxdeploy`
#
# Two separate bugs cause that failure, both worked around here:
#
# 1. Icon name mismatch (Tauri bundler bug): the AppDir's icon is written
#    as "<productName>.png" (e.g. "SlickShot.png") but the generated
#    .desktop file's `Icon=` key uses the sanitized binary name (e.g.
#    "slickshot"), expecting "slickshot.png". appimagetool refuses to
#    package an AppDir whose Icon= target is missing.
# 2. `linuxdeploy`'s own final "build the .AppImage" step
#    (`--output appimage`) fails outright in some environments -- its
#    bundled `appimagetool` needs $ARCH and $LD_LIBRARY_PATH set, which
#    linuxdeploy doesn't appear to pass through correctly. Its error
#    reporting collapses this down to an unhelpful "subprocess failed
#    (exit code 127)".
#
# This script reuses the AppDir that `pnpm tauri build` already fully
# populated (libraries copied, RPATHs patched -- all of that succeeds; only
# the final packaging step fails), fixes the icon, then calls the bundled
# appimagetool directly instead of going through linuxdeploy's broken
# wrapper. See docs/BUILDING.md for the full writeup.
#
# Usage: run after a failed `pnpm tauri build` / `--bundles appimage`.
#   scripts/fix-appimage.sh [target-triple]
# Pass the same target-triple you built with (e.g.
# x86_64-unknown-linux-gnu) if you built via `tauri build --target <...>`
# (CI always does, even for the "native" leg) -- that puts output under
# target/<triple>/release/ instead of plain target/release/. Omit it for a
# plain local `pnpm tauri build` with no --target.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET_TRIPLE="${1:-}"
BUNDLE_DIR="src-tauri/target/${TARGET_TRIPLE:+${TARGET_TRIPLE}/}release/bundle"

CONF="src-tauri/tauri.conf.json"
PRODUCT_NAME=$(jq -r '.productName' "$CONF")
VERSION=$(jq -r '.version' "$CONF")
ARCH=$(uname -m)
# Debian/dpkg-style arch suffix Tauri names the bundle files with -- matches
# linuxdeploy's own per-arch release naming 1:1 for x86_64/aarch64, but not
# for the dpkg suffix (amd64/arm64), so that part needs an explicit map.
case "$ARCH" in
  x86_64) DEB_ARCH="amd64" ;;
  aarch64) DEB_ARCH="arm64" ;;
  *)
    echo "error: unrecognized architecture '$ARCH' -- extend the DEB_ARCH map in this script." >&2
    exit 1
    ;;
esac
APPDIR="${BUNDLE_DIR}/appimage/${PRODUCT_NAME}.AppDir"
DESKTOP_FILE="${APPDIR}/${PRODUCT_NAME}.desktop"
LINUXDEPLOY="${HOME}/.cache/tauri/linuxdeploy-${ARCH}.AppImage"
OUTPUT="${BUNDLE_DIR}/appimage/${PRODUCT_NAME}_${VERSION}_${DEB_ARCH}.AppImage"

if [ ! -d "$APPDIR" ]; then
  echo "error: $APPDIR doesn't exist -- run 'pnpm tauri build --bundles appimage' first (it's expected to fail; this script finishes what it started)." >&2
  exit 1
fi
if [ ! -x "$LINUXDEPLOY" ]; then
  echo "error: $LINUXDEPLOY not found -- run 'pnpm tauri build' at least once so Tauri downloads it." >&2
  exit 1
fi

# --- Fix 1: icon name mismatch ---
ICON_NAME=$(grep -m1 '^Icon=' "$DESKTOP_FILE" | cut -d= -f2)
if [ -z "$ICON_NAME" ]; then
  echo "error: couldn't read Icon= from $DESKTOP_FILE" >&2
  exit 1
fi
if [ ! -f "${APPDIR}/${ICON_NAME}.png" ]; then
  if [ -f "${APPDIR}/${PRODUCT_NAME}.png" ]; then
    echo "Icon mismatch: .desktop wants '${ICON_NAME}.png', AppDir has '${PRODUCT_NAME}.png' -- copying."
    cp "${APPDIR}/${PRODUCT_NAME}.png" "${APPDIR}/${ICON_NAME}.png"
  else
    echo "error: no icon found at ${APPDIR}/${PRODUCT_NAME}.png to copy from." >&2
    exit 1
  fi
fi

# --- Fix 2: call appimagetool directly, bypassing linuxdeploy's broken wrapper ---
# If your system has AppImageLauncher installed, its binfmt_misc handler
# intercepts execution of ANY AppImage -- including linuxdeploy's own cached
# tooling below -- and can hang waiting for a GUI prompt that never comes in
# a non-interactive build. If this script hangs on the extract step, set
# ask_to_move=false and enable_daemon=false in
# ~/.config/appimagelauncher.cfg first (restore them afterward).
EXTRACT_DIR=$(mktemp -d)
trap 'rm -rf "$EXTRACT_DIR"' EXIT
( cd "$EXTRACT_DIR" && "$LINUXDEPLOY" --appimage-extract >/dev/null )
PREFIX="${EXTRACT_DIR}/squashfs-root/plugins/linuxdeploy-plugin-appimage/appimagetool-prefix"

rm -f "$OUTPUT"
ARCH="$ARCH" LD_LIBRARY_PATH="${PREFIX}/usr/lib" "${PREFIX}/usr/bin/appimagetool" "$APPDIR" "$OUTPUT"

echo "Built: $OUTPUT"
