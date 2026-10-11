<#
.SYNOPSIS
  Builds the Android app on EAS: a Play Store bundle (.aab) by default, or with -Apk an
  installable .apk for testing on your own phones.

.DESCRIPTION
  Uses the "production" profile in app/eas.json (AAB) or "preview" (APK, internal
  distribution: EAS prints a link/QR code to install it). Both use the production update
  channel, so update-ios.ps1 -Platform android (or all) reaches them.

  Nothing is uploaded to Google Play automatically. When you want that, set it up once:
    1. Create the app in the Play Console (package com.zachadams.sightline) and upload the
       first .aab by hand (Google requires the first upload to be manual).
    2. In Google Cloud, create a service account, give it access in Play Console
       (Users and permissions > Invite > the service account email, "Release" rights),
       and download its JSON key. Don't commit it.
    3. Upload the key to EAS: npx eas-cli@latest credentials -p android
       (Google Service Account > Upload), or add to app/eas.json under
       submit.production.android: { "serviceAccountKeyPath": "...", "track": "internal" }
    4. Then use -Submit here (adds --auto-submit, which runs "eas submit" after the build).

.PARAMETER FirstRun
  Interactive mode for the first build: EAS offers to generate the Android upload keystore
  and stores it on its servers. Later builds can run unattended.

.PARAMETER Apk
  Build an .apk (preview profile) to install directly instead of a Play Store .aab.

.PARAMETER Submit
  Send the .aab to Google Play after the build (needs the service account above).

.PARAMETER SkipChecks
  Skip local typecheck/lint (not recommended).

.EXAMPLE
  .\scripts\release-android.ps1 -Apk -FirstRun
  .\scripts\release-android.ps1 -Apk
  .\scripts\release-android.ps1
  .\scripts\release-android.ps1 -Submit
#>
param(
    [switch]$FirstRun,
    [switch]$Apk,
    [switch]$Submit,
    [switch]$SkipChecks
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$app = Join-Path $root 'app'

if ($Apk -and $Submit) { throw '-Submit uploads to Google Play, which takes the .aab; drop -Apk' }

# EAS uploads the git tree, so uncommitted changes would not be in the build.
$dirty = git -C $root status --porcelain
if ($dirty) {
    Write-Host 'You have uncommitted changes. EAS builds what is committed:' -ForegroundColor Yellow
    Write-Host $dirty
    $answer = Read-Host 'Continue anyway? (y/N)'
    if ($answer -ne 'y') { exit 1 }
}

Push-Location $app
try {
    if (-not $SkipChecks) {
        Write-Host '== Typecheck & lint ==' -ForegroundColor Cyan
        npx tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
        npx expo lint
        if ($LASTEXITCODE -ne 0) { throw 'Lint failed' }
    }

    $easProfile = if ($Apk) { 'preview' } else { 'production' }
    Write-Host "== EAS Android build ($easProfile) ==" -ForegroundColor Cyan
    $easArgs = @('eas-cli@latest', 'build', '--platform', 'android', '--profile', $easProfile)
    if ($Submit) { $easArgs += '--auto-submit' }
    if (-not $FirstRun) { $easArgs += '--non-interactive' }
    npx @easArgs
    if ($LASTEXITCODE -ne 0) { throw 'EAS build failed' }

    Write-Host ''
    if ($Apk) {
        Write-Host 'Done. Open the build link above on the Android phone (or scan its QR code) to' -ForegroundColor Green
        Write-Host 'install the .apk; allow "Install unknown apps" for the browser when asked.' -ForegroundColor Green
    }
    elseif ($Submit) {
        Write-Host 'Submitted to Google Play. It appears on the track set in eas.json (Play Console > Testing).' -ForegroundColor Green
    }
    else {
        Write-Host 'Done. Download the .aab from the build link above and upload it in the Play Console,' -ForegroundColor Green
        Write-Host 'or set up a service account (see Get-Help .\scripts\release-android.ps1) and use -Submit.' -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
