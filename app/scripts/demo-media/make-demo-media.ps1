# Regenerates the sample-camera footage for Demo mode (app/assets/demo).
# Windows PowerShell 5.1 + ffmpeg with libx264 (e.g. `npm i ffmpeg-static` somewhere and pass its path).
#   powershell -ExecutionPolicy Bypass -File scripts/demo-media/make-demo-media.ps1 -Ffmpeg C:\path\to\ffmpeg.exe
# All footage is drawn by Scenes.cs from simple shapes, so it carries no third-party license.
param(
  [string]$Ffmpeg = 'ffmpeg',
  [string]$Out = (Join-Path $PSScriptRoot '..\..\assets\demo'),
  [int]$Crf = 30
)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'Scenes.cs') -ReferencedAssemblies System.Drawing
[DemoMedia]::Ffmpeg = $Ffmpeg
$full = [System.IO.Path]::GetFullPath($Out)
[DemoMedia]::Build($full, $Crf)
Get-ChildItem $full | Select-Object Name, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB) } } | Format-Table -AutoSize
'{0:N1} MB total' -f ((Get-ChildItem $full | Measure-Object Length -Sum).Sum / 1MB)
