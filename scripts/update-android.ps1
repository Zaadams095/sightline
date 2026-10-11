<#
.SYNOPSIS
  Publishes a JavaScript-only update to installed Android builds (no build credit).
  Same rules as update-ios.ps1; use "update-ios.ps1 -Platform all" to update both at once.

.EXAMPLE
  .\scripts\update-android.ps1 -Message "Fix Frigate connection error"
#>
param(
    [Parameter(Mandatory = $true)][string]$Message
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'update-ios.ps1') -Message $Message -Platform android
