<#
.SYNOPSIS
  One-time setup: links the app to your Expo account and EAS project.

.DESCRIPTION
  Run once from PowerShell. It will:
    1. Log you in to Expo (opens a browser / asks for credentials).
    2. Create the EAS project and write its ID into app.json.
  Apple signing credentials and the App Store Connect app record are created on the
  first release build (scripts/release-ios.ps1 -FirstRun), which asks for your Apple ID.
#>
$ErrorActionPreference = 'Stop'
$app = Join-Path $PSScriptRoot '..\app'
Push-Location $app
try {
    Write-Host '== Expo login ==' -ForegroundColor Cyan
    npx eas-cli@latest whoami 2>$null
    if ($LASTEXITCODE -ne 0) { npx eas-cli@latest login }

    Write-Host '== Linking EAS project ==' -ForegroundColor Cyan
    npx eas-cli@latest init

    Write-Host ''
    Write-Host 'Done. Next: .\scripts\release-ios.ps1 -FirstRun' -ForegroundColor Green
}
finally {
    Pop-Location
}
