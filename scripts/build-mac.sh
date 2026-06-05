#!/bin/bash
# Build a macOS .app, AD-HOC SIGN it, and package a clean .dmg.
# Why: on Apple Silicon an unsigned app is rejected by macOS as "damaged" and thrown in the Trash.
# electron-builder with identity:null skips signing entirely, so we sign the app ourselves
# (codesign --sign -) and build the dmg with hdiutil. Not Apple-notarized (that needs a $99/yr
# Developer ID), so first launch still needs a right-click -> Open, but it no longer reports "damaged".
set -e
cd "$(dirname "$0")/.."

APP="release/mac-arm64/Code Tree.app"
DMG="release/Code Tree.dmg"

echo "==> building the .app (no dmg yet)"
rm -rf release/mac-arm64 "$DMG"
npx electron-builder --mac dir

echo "==> ad-hoc signing"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" && echo "    signature OK"
xattr -cr "$APP"

echo "==> packaging the dmg (with an Applications shortcut)"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Code Tree" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
xattr -cr "$DMG"
rm -rf "$STAGE"

echo "==> done: $DMG (ad-hoc signed, $(du -h "$DMG" | cut -f1))"
