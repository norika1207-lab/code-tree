#!/usr/bin/env bash
# Build a macOS .app and package a clean .dmg.
#
# Default behavior:
# - If a Developer ID Application certificate is available, sign with hardened runtime.
# - If no Developer ID certificate is available, fall back to ad-hoc signing so local test builds still work.
#
# Notarized release behavior:
# - Set CODETREE_NOTARIZE=1 and provide either CODETREE_NOTARY_PROFILE or Apple notary env vars.
# - The script submits the DMG to Apple, staples the ticket, and validates the staple.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="release/mac-arm64/Code Tree.app"
DMG="release/Code Tree.dmg"
ENTITLEMENTS="electron/entitlements.mac.plist"

want_notarize() {
  case "${CODETREE_NOTARIZE:-0}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

find_developer_id_identity() {
  security find-identity -v -p codesigning \
    | awk -F '"' '/Developer ID Application:/ { print $2 }' \
    | sed -n '1p'
}

select_sign_identity() {
  if [[ -n "${CODETREE_SIGN_IDENTITY:-}" ]]; then
    printf '%s\n' "$CODETREE_SIGN_IDENTITY"
    return 0
  fi

  local identity
  identity="$(find_developer_id_identity || true)"
  if [[ -n "$identity" ]]; then
    printf '%s\n' "$identity"
    return 0
  fi

  return 1
}

submit_for_notarization() {
  echo "==> submitting dmg to Apple notarization"

  if [[ -n "${CODETREE_NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$DMG" \
      --keychain-profile "$CODETREE_NOTARY_PROFILE" \
      --wait
    return
  fi

  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    xcrun notarytool submit "$DMG" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
    return
  fi

  if [[ -n "${APPSTORE_CONNECT_KEY_ID:-}" && -n "${APPSTORE_CONNECT_ISSUER_ID:-}" && -n "${APPSTORE_CONNECT_API_KEY:-}" ]]; then
    xcrun notarytool submit "$DMG" \
      --key "$APPSTORE_CONNECT_API_KEY" \
      --key-id "$APPSTORE_CONNECT_KEY_ID" \
      --issuer "$APPSTORE_CONNECT_ISSUER_ID" \
      --wait
    return
  fi

  cat >&2 <<'EOF'
Notarization requested, but no Apple notary credentials were provided.

Use one of these:
  CODETREE_NOTARY_PROFILE=codetree-notary
  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
  APPSTORE_CONNECT_KEY_ID + APPSTORE_CONNECT_ISSUER_ID + APPSTORE_CONNECT_API_KEY
EOF
  exit 1
}

has_notary_credentials() {
  [[ -n "${CODETREE_NOTARY_PROFILE:-}" ]] && return 0
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] && return 0
  [[ -n "${APPSTORE_CONNECT_KEY_ID:-}" && -n "${APPSTORE_CONNECT_ISSUER_ID:-}" && -n "${APPSTORE_CONNECT_API_KEY:-}" ]] && return 0
  return 1
}

if want_notarize; then
  if ! select_sign_identity >/dev/null; then
    cat >&2 <<'EOF'
CODETREE_NOTARIZE=1 requires a Developer ID Application certificate in Keychain.
Current Keychain has no usable "Developer ID Application:" signing identity.
EOF
    exit 1
  fi

  if ! has_notary_credentials; then
    cat >&2 <<'EOF'
CODETREE_NOTARIZE=1 also requires Apple notarization credentials.

Recommended:
  xcrun notarytool store-credentials codetree-notary --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID --password APP_SPECIFIC_PASSWORD
  CODETREE_NOTARY_PROFILE=codetree-notary npm run dist:notarize
EOF
    exit 1
  fi
fi

echo "==> building the .app (no dmg yet)"
rm -rf release/mac-arm64 "$DMG"
npx electron-builder --mac dir

echo "==> removing unused macOS privacy prompts"
scripts/sanitize-mac-permissions.sh "$APP"

SIGN_MODE="ad-hoc"
SIGN_IDENTITY=""

if SIGN_IDENTITY="$(select_sign_identity)"; then
  SIGN_MODE="developer-id"
  echo "==> Developer ID signing"
  echo "    identity: $SIGN_IDENTITY"
  codesign --force --deep \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGN_IDENTITY" \
    "$APP"
else
  if want_notarize; then
    cat >&2 <<'EOF'
CODETREE_NOTARIZE=1 requires a Developer ID Application certificate in Keychain.
Current Keychain has no usable "Developer ID Application:" signing identity.
EOF
    exit 1
  fi

  echo "==> ad-hoc signing"
  echo "    no Developer ID Application certificate found; this build is for local testing only"
  codesign --force --deep --sign - "$APP"
fi

codesign --verify --deep --strict --verbose=2 "$APP" && echo "    signature OK"
xattr -cr "$APP"

echo "==> packaging the dmg (with an Applications shortcut)"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Code Tree" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
xattr -cr "$DMG"
rm -rf "$STAGE"

if [[ "$SIGN_MODE" == "developer-id" ]] && want_notarize; then
  submit_for_notarization

  echo "==> stapling notarization ticket"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
elif [[ "$SIGN_MODE" == "developer-id" ]]; then
  echo "==> Developer ID signed, but not notarized"
  echo "    set CODETREE_NOTARIZE=1 to remove Gatekeeper's external-download warning"
fi

echo "==> done: $DMG ($SIGN_MODE, $(du -h "$DMG" | cut -f1))"
