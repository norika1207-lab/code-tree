#!/bin/bash
# One command to ship: build the ad-hoc-signed dmg, publish it to the VPS, and push git.
# Keeps the desktop build, the VPS download, and the repo in sync. Run: npm run release
set -e
cd "$(dirname "$0")/.."

VPS=sportverse
VPS_DIR=/opt/codetree
DMG="release/Code Tree.dmg"
REMOTE_NAME="Code-Tree-0.1.0-arm64.dmg"

echo "==> 1/3 build (signed dmg)"
bash scripts/build-mac.sh

echo "==> 2/3 publish to ${VPS}:${VPS_DIR}"
ssh "$VPS" "mkdir -p ${VPS_DIR}"
scp "$DMG" "${VPS}:${VPS_DIR}/${REMOTE_NAME}"
LOCAL_SHA=$(shasum -a 256 "$DMG" | awk '{print $1}')
REMOTE_SHA=$(ssh "$VPS" "shasum -a 256 ${VPS_DIR}/${REMOTE_NAME} | awk '{print \$1}'")
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] && echo "    sha match: $LOCAL_SHA" || { echo "    SHA MISMATCH — upload corrupted"; exit 1; }

echo "==> 3/3 git push"
git push origin main || echo "    (nothing to push, or push blocked)"

echo "done: desktop, ${VPS}:${VPS_DIR}/${REMOTE_NAME}, and git are in sync."
