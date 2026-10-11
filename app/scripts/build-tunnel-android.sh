#!/usr/bin/env bash
# Builds tunnel/ (Go) into wgtunnel.aar for the wg-tunnel Expo module's Android side, then
# unpacks it into what the module's Gradle file uses:
#   modules/wg-tunnel/android/libs/wgtunnel-classes.jar   (Java bindings, package wgtunnel)
#   modules/wg-tunnel/android/libs/jni/<abi>/libgojni.so  (the Go library)
# Runs automatically on EAS Android builders via the "eas-build-pre-install" npm hook and in
# .github/workflows/android-compile.yml. Needs a JDK (javac/jar) and the Android SDK + NDK.
# Env: ANDROID_NDK_HOME, else ANDROID_HOME / ANDROID_SDK_ROOT (newest ndk/<version> is used).
#      WGTUNNEL_ANDROID_TARGETS to narrow the ABIs (default: all four, like React Native).
set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-android}" != "android" ]]; then
  echo "Skipping tunnel Android build for platform ${EAS_BUILD_PLATFORM}"
  exit 0
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_DIR="$APP_DIR/../tunnel"
LIBS="$APP_DIR/modules/wg-tunnel/android/libs"
AAR="$LIBS/wgtunnel.aar"
TARGETS="${WGTUNNEL_ANDROID_TARGETS:-android}"

# --- Android SDK / NDK -------------------------------------------------------------------
if [[ -z "${ANDROID_HOME:-}" ]]; then
  for d in "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" /usr/local/lib/android/sdk; do
    if [[ -n "$d" && -d "$d" ]]; then export ANDROID_HOME="$d"; break; fi
  done
fi
if [[ -z "${ANDROID_HOME:-}" ]]; then
  echo "error: Android SDK not found (set ANDROID_HOME)" >&2
  exit 1
fi
if [[ -n "${ANDROID_NDK_HOME:-}" && ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "ANDROID_NDK_HOME=$ANDROID_NDK_HOME does not exist; looking under the SDK instead"
  unset ANDROID_NDK_HOME
fi
if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_NDK_ROOT:-}" && -d "$ANDROID_NDK_ROOT" ]]; then
  export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
fi
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  NDK="$(ls -d "$ANDROID_HOME"/ndk/*/ 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "$NDK" ]]; then export ANDROID_NDK_HOME="${NDK%/}"; fi
fi
if [[ -z "${ANDROID_NDK_HOME:-}" && ! -d "$ANDROID_HOME/ndk-bundle" ]]; then
  echo "error: no Android NDK under $ANDROID_HOME (install one with sdkmanager 'ndk;27.1.12297006')" >&2
  exit 1
fi
echo "Android SDK: $ANDROID_HOME"
echo "Android NDK: ${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk-bundle}"

# --- Go ------------------------------------------------------------------------------------
# EAS Android images (Ubuntu) have no Go; fetch the official release (go.mod needs >= 1.26).
if ! command -v go >/dev/null 2>&1; then
  GO_VERSION="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n 1)"
  case "$(uname -m)" in
    x86_64|amd64) GO_ARCH=amd64 ;;
    aarch64|arm64) GO_ARCH=arm64 ;;
    *) echo "error: unsupported CPU $(uname -m)" >&2; exit 1 ;;
  esac
  GO_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  echo "Installing $GO_VERSION ($GO_OS/$GO_ARCH)..."
  mkdir -p "$HOME/.local"
  curl -fsSL "https://go.dev/dl/${GO_VERSION}.${GO_OS}-${GO_ARCH}.tar.gz" | tar -xz -C "$HOME/.local"
  export PATH="$HOME/.local/go/bin:$PATH"
fi
export PATH="$PATH:$(go env GOPATH)/bin"
go version

go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest
gomobile init

# --- Build + unpack --------------------------------------------------------------------------
mkdir -p "$LIBS"
rm -rf "$AAR" "$LIBS/wgtunnel-sources.jar" "$LIBS/wgtunnel-classes.jar" "$LIBS/jni"
cd "$TUNNEL_DIR"
gomobile bind -target="$TARGETS" -androidapi 24 -ldflags="-s -w" -o "$AAR" ./wgtunnel

UNPACK="$(mktemp -d)"
trap 'rm -rf "$UNPACK"' EXIT
(cd "$UNPACK" && jar xf "$AAR")
cp "$UNPACK/classes.jar" "$LIBS/wgtunnel-classes.jar"
cp -R "$UNPACK/jni" "$LIBS/jni"

echo "Built $AAR"
find "$LIBS/jni" -name '*.so' -exec ls -l {} \;
