#!/usr/bin/env bash
# Builds tunnel/ (Go) into Wgtunnel.xcframework for the wg-tunnel Expo module.
# Runs automatically on EAS macOS builders via the "eas-build-pre-install" npm hook,
# so no local Mac is needed. Safe to run locally on a Mac too.
set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-ios}" != "ios" ]]; then
  echo "Skipping tunnel iOS build for platform ${EAS_BUILD_PLATFORM}"
  exit 0
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_DIR="$APP_DIR/../tunnel"
OUT="$APP_DIR/modules/wg-tunnel/ios/Wgtunnel.xcframework"

if ! command -v go >/dev/null 2>&1; then
  echo "Installing Go..."
  brew install go
fi
export PATH="$PATH:$(go env GOPATH)/bin"

go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest
gomobile init

cd "$TUNNEL_DIR"
rm -rf "$OUT"
gomobile bind -target=ios,iossimulator -iosversion=17.1 -ldflags="-s -w" -o "$OUT" ./wgtunnel
echo "Built $OUT"
