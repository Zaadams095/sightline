<#
.SYNOPSIS
  Builds the iOS app on EAS and submits it to TestFlight.

.PARAMETER FirstRun
  Interactive mode for the first build: EAS asks for your Apple ID, creates the
  distribution certificate, provisioning profile and push key, and creates the app in
  App Store Connect. Later builds can run unattended.

.PARAMETER SkipChecks
  Skip local typecheck/lint (not recommended).

.EXAMPLE
  .\scripts\release-ios.ps1 -FirstRun
  .\scripts\release-ios.ps1
#>
param(
    [switch]$FirstRun,
    [switch]$SkipChecks
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$app = Join-Path $root 'app'

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

    Write-Host '== EAS build + submit to TestFlight ==' -ForegroundColor Cyan
    $easArgs = @('eas-cli@latest', 'build', '--platform', 'ios', '--profile', 'production', '--auto-submit')
    if (-not $FirstRun) { $easArgs += '--non-interactive' }
    npx @easArgs
    if ($LASTEXITCODE -ne 0) { throw 'EAS build failed' }

    Write-Host ''
    Write-Host 'Submitted. Apple takes ~5-15 minutes to process the build; it then appears in' -ForegroundColor Green
    Write-Host 'TestFlight for your internal testers (App Store Connect > TestFlight).' -ForegroundColor Green
}
finally {
    Pop-Location
}
