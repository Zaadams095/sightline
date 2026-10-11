#!/usr/bin/env bash
# EAS "eas-build-pre-install" hook: builds the Go tunnel for the platform being built.
# EAS sets EAS_BUILD_PLATFORM to "ios" or "android".
set -euo pipefail
cd "$(dirname "$0")"

case "${EAS_BUILD_PLATFORM:-}" in
  ios)
    bash build-tunnel-ios.sh
    bash ensure-watchos-sdk.sh
    ;;
  android)
    bash build-tunnel-android.sh
    ;;
  *)
    echo "error: EAS_BUILD_PLATFORM is '${EAS_BUILD_PLATFORM:-}' (expected ios or android)" >&2
    exit 1
    ;;
esac
