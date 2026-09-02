#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CODETREE_BASE_URL:-http://codetree.31.97.221.240.nip.io}"
RUNTIME_BASE_URL="${CODETREE_RUNTIME_BASE_URL:-https://github.com/norika1207-lab/code-tree/releases/download/installer-latest}"
SOURCE_URL="${CODETREE_TARBALL_URL:-$BASE_URL/code-tree-latest.tgz}"
INSTALL_DIR="${CODETREE_INSTALL_DIR:-$HOME/.code-tree/app}"
BIN_DIR="${CODETREE_BIN_DIR:-$HOME/.local/bin}"
APP_NAME="Code Tree"

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'Code Tree install failed: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need_cmd curl
need_cmd tar
need_cmd node
need_cmd npm

node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 18 ? 0 : 1)' \
  || die "Node.js 18+ is required. Current version: $(node -v)"

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
CPU_ARCH="$(uname -m)"
RUNTIME_URL="${CODETREE_RUNTIME_URL:-}"
if [[ -z "$RUNTIME_URL" && "$OS_NAME" == "darwin" && "$CPU_ARCH" == "arm64" ]]; then
  RUNTIME_URL="$RUNTIME_BASE_URL/code-tree-darwin-arm64.tgz"
fi
INSTALL_GUI="${CODETREE_INSTALL_GUI:-0}"

TMP="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

say "==> Installing $APP_NAME"
say "    target: $INSTALL_DIR"

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

say "==> Downloading"
DOWNLOADED_RUNTIME=0
if [[ "${CODETREE_USE_RUNTIME:-0}" == "1" && "${CODETREE_SOURCE_INSTALL:-0}" != "1" && -n "$RUNTIME_URL" ]]; then
  say "    runtime: $RUNTIME_URL"
  if curl -fL "$RUNTIME_URL" -o "$TMP/code-tree.tgz"; then
    DOWNLOADED_RUNTIME=1
  else
    say "    runtime unavailable; falling back to source install"
  fi
fi

if [[ "$DOWNLOADED_RUNTIME" != "1" ]]; then
  say "    source: $SOURCE_URL"
  curl -fL "$SOURCE_URL" -o "$TMP/code-tree.tgz"
fi

mkdir "$TMP/app"
tar -xzf "$TMP/code-tree.tgz" -C "$TMP/app" --strip-components=1

cd "$TMP/app"

if [[ -d node_modules && "$DOWNLOADED_RUNTIME" == "1" ]]; then
  say "==> Using bundled Node dependencies"
else
  say "==> Installing Node dependencies"
  NPM_FLAGS=(
    --ignore-scripts=false
    --dangerously-allow-all-scripts=true
    --no-audit
    --no-fund
  )
  if [[ "$INSTALL_GUI" == "1" ]]; then
    NPM_FLAGS+=(--include=dev)
  else
    NPM_FLAGS+=(--omit=dev)
  fi
  if [[ -f package-lock.json ]]; then
    npm ci "${NPM_FLAGS[@]}"
  else
    npm install "${NPM_FLAGS[@]}"
  fi
fi

say "==> Verifying runtime"
if [[ "$INSTALL_GUI" == "1" ]]; then
  node -e 'require("electron"); require("node-pty"); console.log("    electron + node-pty OK")'
  LAUNCHER_TARGET="bin/codetree.js"
else
  node -e 'require("node-pty"); console.log("    node-pty OK")'
  LAUNCHER_TARGET="bin/cosmos-tree.js"
fi

chmod +x bin/codetree.js bin/cosmos-tree.js
xattr -cr "$TMP/app" >/dev/null 2>&1 || true

BACKUP_DIR="${INSTALL_DIR}.previous"
rm -rf "$BACKUP_DIR"
if [[ -d "$INSTALL_DIR" ]]; then
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi
mv "$TMP/app" "$INSTALL_DIR"

cat > "$BIN_DIR/codetree" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/$LAUNCHER_TARGET" "\$@"
EOF
chmod +x "$BIN_DIR/codetree"
ln -sf "$BIN_DIR/codetree" "$BIN_DIR/code-tree"

SHELL_RC=""
case "$(basename "${SHELL:-}")" in
  zsh) SHELL_RC="$HOME/.zshrc" ;;
  bash) SHELL_RC="$HOME/.bashrc" ;;
esac

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  if [[ -n "$SHELL_RC" ]]; then
    touch "$SHELL_RC"
    if ! grep -Fq 'Code Tree installer' "$SHELL_RC"; then
      {
        printf '\n# Code Tree installer\n'
        printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
      } >> "$SHELL_RC"
    fi
  fi
  say "==> PATH note"
  say "    This terminal may not see codetree yet. Run:"
  say "    export PATH=\"$BIN_DIR:\$PATH\""
fi

say "==> Done"
say "    Run: codetree"
say "    Or:  codetree /path/to/project"
