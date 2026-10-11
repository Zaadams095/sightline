<#
.SYNOPSIS
  Publishes a JavaScript-only update to installed TestFlight builds (no build credit).

.DESCRIPTION
  Works for changes under app/src (screens, logic, styles). Anything native (new
  packages with native code, app.json plugins/permissions, the Go tunnel, Swift,
  the notification extension) needs a full build: .\scripts\release-ios.ps1
  Phones pick the update up the next time the app is opened (sometimes the launch after).

.EXAMPLE
  .\scripts\update-ios.ps1 -Message "Fix Frigate connection error"
#>
param(
    [Parameter(Mandatory = $true)][string]$Message
)
$ErrorActionPreference = 'Stop'
$app = Join-Path $PSScriptRoot '..\app'
Push-Location $app
try {
    npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
    npx eas-cli@latest update --channel production --platform ios --message $Message --non-interactive
    if ($LASTEXITCODE -ne 0) { throw 'EAS update failed' }
}
finally {
    Pop-Location
}
