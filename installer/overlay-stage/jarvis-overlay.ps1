<#
  jarvis-overlay.ps1 — Windows JARVIS overlay stage, bundled into JARVIS-Setup.

  Run by the installer (via powershell.exe -File) AFTER upstream install.ps1
  finishes its pristine Hermes install. Clones the jarvis-agent overlay, then
  hands off to install-jarvis.sh in overlay-only mode under Git Bash (installed
  by install.ps1's Stage-Git) — apply.sh branding + branded desktop build +
  JARVIS.lnk shortcuts + jarvis command shim.

  Usage:  powershell -File jarvis-overlay.ps1 <install_root>
  Idempotent.
#>
param([Parameter(Mandatory = $true, Position = 0)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'

$hermesHome = Split-Path -Parent $InstallRoot
$overlay    = Join-Path $hermesHome 'jarvis-agent'
$ref  = if ($env:JARVIS_OVERLAY_REF)  { $env:JARVIS_OVERLAY_REF }  else { 'main' }
$repo = if ($env:JARVIS_OVERLAY_REPO) { $env:JARVIS_OVERLAY_REPO } else { 'https://github.com/xcerebroai/jarvis-agent' }

Write-Host "[jarvis] overlay stage — install_root=$InstallRoot ref=$ref"

if (Test-Path (Join-Path $overlay '.git')) {
  Write-Host "[jarvis] updating overlay checkout at $overlay"
  git -C $overlay fetch --depth 1 origin $ref
  git -C $overlay checkout -f FETCH_HEAD
} else {
  Write-Host "[jarvis] cloning overlay ($ref) into $overlay"
  git clone --depth 1 --branch $ref $repo $overlay 2>$null
  if ($LASTEXITCODE -ne 0) { git clone --depth 1 $repo $overlay }
}

# Locate Git Bash (Stage-Git installed Git for Windows).
$bash = @(
  "$env:ProgramFiles\Git\bin\bash.exe",
  "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
  "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) {
  $g = Get-Command bash -ErrorAction SilentlyContinue
  if ($g) { $bash = $g.Source }
}
if (-not $bash) { Write-Error 'Git Bash not found; cannot apply the JARVIS overlay.'; exit 1 }

# Hand off to install-jarvis.sh in overlay-only mode (forward-slash paths for bash).
$rootPosix    = ($InstallRoot -replace '\\', '/')
$overlayPosix = ($overlay -replace '\\', '/')
Write-Host "[jarvis] applying overlay (overlay-only mode) against $InstallRoot"
& $bash -lc "JARVIS_OVERLAY_ONLY=1 HERMES_SRC='$rootPosix' bash '$overlayPosix/install-jarvis.sh'"
exit $LASTEXITCODE
