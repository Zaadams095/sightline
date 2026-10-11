#!/usr/bin/env bash
# The iPhone app embeds the Apple Watch app (targets/watch), so the build needs Xcode's
# watchOS platform. Newer Xcode installs can leave it out; download it when it's missing.
# Runs in the "eas-build-pre-install" hook and in .github/workflows/ios-compile.yml.
set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-ios}" != "ios" ]]; then
  exit 0
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "No Xcode here; skipping the watchOS SDK check"
  exit 0
fi

if xcodebuild -showsdks 2>/dev/null | grep -q -- '-sdk watchos'; then
  echo "watchOS SDK present"
else
  echo "watchOS SDK missing; downloading the watchOS platform…"
  xcodebuild -downloadPlatform watchOS
fi
