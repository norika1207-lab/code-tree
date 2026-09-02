#!/usr/bin/env bash
set -euo pipefail

APP="${1:-/Applications/Code Tree.app}"
PLIST="$APP/Contents/Info.plist"

if [[ ! -f "$PLIST" ]]; then
  echo "Info.plist not found: $PLIST" >&2
  exit 1
fi

for key in \
  NSCameraUsageDescription \
  NSMicrophoneUsageDescription \
  NSAudioCaptureUsageDescription \
  NSBluetoothAlwaysUsageDescription \
  NSBluetoothPeripheralUsageDescription \
  NSAppleMusicUsageDescription \
  NSPhotoLibraryUsageDescription \
  NSPhotoLibraryAddUsageDescription; do
  /usr/libexec/PlistBuddy -c "Delete :$key" "$PLIST" >/dev/null 2>&1 || true
done

/usr/libexec/PlistBuddy -c "Set :NSDocumentsFolderUsageDescription Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :NSDocumentsFolderUsageDescription string Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSDesktopFolderUsageDescription Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :NSDesktopFolderUsageDescription string Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSDownloadsFolderUsageDescription Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :NSDownloadsFolderUsageDescription string Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSNetworkVolumesUsageDescription Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :NSNetworkVolumesUsageDescription string Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST"
/usr/libexec/PlistBuddy -c "Set :NSRemovableVolumesUsageDescription Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :NSRemovableVolumesUsageDescription string Code Tree reads the project folder you choose so it can draw its file structure." "$PLIST"

echo "sanitized macOS permission descriptions: $APP"
