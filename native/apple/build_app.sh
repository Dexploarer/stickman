#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR"
PROJECT_ROOT="$(cd "$NATIVE_DIR/../.." && pwd)"

APP_NAME="Prompt or Die Social Suite.app"
APP_DIST_DIR="$NATIVE_DIR/dist/$APP_NAME"
APP_SYSTEM_APPS_DIR="/Applications"
APP_USER_APPS_DIR="$HOME/Applications"
APP_SYSTEM_TARGET="$APP_SYSTEM_APPS_DIR/$APP_NAME"
APP_USER_TARGET="$APP_USER_APPS_DIR/$APP_NAME"
APP_DESKTOP_STALE="$HOME/Desktop/$APP_NAME"
BIN_NAME="PromptOrDieSocialSuiteNative"
BIN_PATH="$NATIVE_DIR/.build/release/$BIN_NAME"
BUN_PATH="$(command -v bun || true)"
NODE_PATH="$(command -v node || true)"
if [[ -z "$BUN_PATH" ]]; then
  BUN_PATH="/Users/home/.bun/bin/bun"
fi
if [[ -z "$NODE_PATH" ]]; then
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    NODE_PATH="/opt/homebrew/bin/node"
  elif [[ -x "/usr/local/bin/node" ]]; then
    NODE_PATH="/usr/local/bin/node"
  else
    NODE_PATH="/usr/bin/node"
  fi
fi

cd "$NATIVE_DIR"

echo "Building native app binary..."
swift build -c release

echo "Assembling app bundle..."
rm -rf "$APP_DIST_DIR"
mkdir -p "$APP_DIST_DIR/Contents/MacOS" "$APP_DIST_DIR/Contents/Resources"

cp "$BIN_PATH" "$APP_DIST_DIR/Contents/MacOS/${BIN_NAME}.bin"
chmod +x "$APP_DIST_DIR/Contents/MacOS/${BIN_NAME}.bin"

echo "Bundling server runtime..."
"$BUN_PATH" build "$PROJECT_ROOT/src/server.ts" --target=node --format=esm --outfile "$APP_DIST_DIR/Contents/Resources/server.mjs" >/dev/null
cp -R "$PROJECT_ROOT/web" "$APP_DIST_DIR/Contents/web"
cp -R "$PROJECT_ROOT/x-local" "$APP_DIST_DIR/Contents/x-local"

echo "Bootstrapping bundled x-local runtime (python + playwright)..."
if ! bash "$APP_DIST_DIR/Contents/x-local/setup_env.sh" >/dev/null 2>&1; then
  echo "warning: bundled x-local bootstrap failed during build; app will attempt setup on first x-local call" >&2
fi

cat > "$APP_DIST_DIR/Contents/MacOS/$BIN_NAME" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export POD_BUN_PATH="$BUN_PATH"
export POD_NODE_PATH="$NODE_PATH"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/home/.bun/bin:\$PATH"
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
APP_ROOT="\$(cd "\$SCRIPT_DIR/.." && pwd)"
SERVER_BUNDLE="\$APP_ROOT/Resources/server.mjs"
export POD_SUITE_ROOT="\$APP_ROOT"

NODE_BIN="\${POD_NODE_PATH}"
if [[ ! -x "\$NODE_BIN" ]]; then
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
  elif [[ -x "/usr/local/bin/node" ]]; then
    NODE_BIN="/usr/local/bin/node"
  elif [[ -x "/usr/bin/node" ]]; then
    NODE_BIN="/usr/bin/node"
  else
    NODE_BIN=""
  fi
fi

exec "\$SCRIPT_DIR/${BIN_NAME}.bin"
EOF
chmod +x "$APP_DIST_DIR/Contents/MacOS/$BIN_NAME"

cat > "$APP_DIST_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Prompt or Die Social Suite</string>
  <key>CFBundleExecutable</key>
  <string>$BIN_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>com.promptordie.socialsuite</string>
  <key>CFBundleName</key>
  <string>Prompt or Die Social Suite</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIST_DIR" >/dev/null 2>&1 || true
fi

INSTALL_TARGET=""
echo "Installing app..."
if mkdir -p "$APP_SYSTEM_APPS_DIR" >/dev/null 2>&1 && rm -rf "$APP_SYSTEM_TARGET" >/dev/null 2>&1 && cp -R "$APP_DIST_DIR" "$APP_SYSTEM_TARGET" >/dev/null 2>&1; then
  INSTALL_TARGET="$APP_SYSTEM_TARGET"
else
  mkdir -p "$APP_USER_APPS_DIR"
  rm -rf "$APP_USER_TARGET"
  cp -R "$APP_DIST_DIR" "$APP_USER_TARGET"
  INSTALL_TARGET="$APP_USER_TARGET"
fi

# Remove stale Desktop copy to avoid launching wrong bundle path.
rm -rf "$APP_DESKTOP_STALE" >/dev/null 2>&1 || true

echo "App installed:"
echo "$INSTALL_TARGET"

echo "Launching app..."
open "$INSTALL_TARGET"
