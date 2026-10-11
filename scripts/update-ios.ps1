<#
.SYNOPSIS
  Publishes a JavaScript-only update to installed builds (no build credit).
  iPhone (TestFlight) by default; -Platform android or all for Android builds.

.DESCRIPTION
  Works for changes under app/src (screens, logic, styles). Anything native (new
  packages with native code, app.json plugins/permissions, the Go tunnel, Swift/Kotlin,
  the notification extension) needs a full build: .\scripts\release-ios.ps1 or
  .\scripts\release-android.ps1
  Phones pick the update up the next time the app is opened (sometimes the launch after).

  Updates only reach builds with the same app version (runtimeVersion policy "appVersion").
  When a change adds native code, bump "version" in app/app.json before the new build, so
  JavaScript that needs the new native code is never sent to older installed builds.

.PARAMETER Platform
  ios (default), android, or all.

.EXAMPLE
  .\scripts\update-ios.ps1 -Message "Fix Frigate connection error"
  .\scripts\update-ios.ps1 -Message "Fix Frigate connection error" -Platform all
#>
param(
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet('ios', 'android', 'all')][string]$Platform = 'ios'
)
$ErrorActionPreference = 'Stop'
$app = Join-Path $PSScriptRoot '..\app'
Push-Location $app
try {
    npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
    npx eas-cli@latest update --channel production --environment production --platform $Platform --message $Message --non-interactive
    if ($LASTEXITCODE -ne 0) { throw 'EAS update failed' }
}
finally {
    Pop-Location
}
