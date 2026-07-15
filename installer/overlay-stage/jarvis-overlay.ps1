<#
  jarvis-overlay.ps1 — Windows JARVIS overlay stage (embedded in JARVIS-Setup).

  Run by the installer AFTER upstream install.ps1 finishes its pristine Hermes
  install. Acquires the jarvis-agent overlay checkout pinned to $Ref, then
  hands off to install-jarvis.sh in overlay-only mode under Git Bash
  (installed by install.ps1's Stage-Git) — apply.sh branding + branded desktop
  build + JARVIS shortcuts + jarvis command shim.

  Usage:  powershell -File jarvis-overlay.ps1 <install_root> [<ref>]
  Idempotent.

  PowerShell 5.1 safety (finding #2): native stderr is NEVER redirected here.
  In 5.1, redirecting a native command's stderr (2>$null / 2>&1) wraps each
  line in a NativeCommandError record, and with $ErrorActionPreference='Stop'
  even git's normal progress output ("Cloning into...") becomes a terminating
  error. Success/failure is judged ONLY by $LASTEXITCODE.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$InstallRoot,
  [Parameter(Position = 1)][string]$Ref = 'main'
)
$ErrorActionPreference = 'Stop'

$hermesHome = Split-Path -Parent $InstallRoot
$overlay    = Join-Path $hermesHome 'jarvis-agent'
$repo = if ($env:JARVIS_OVERLAY_REPO) { $env:JARVIS_OVERLAY_REPO } else { 'https://github.com/xcerebroai/jarvis-agent' }
if ($env:JARVIS_OVERLAY_REF) { $Ref = $env:JARVIS_OVERLAY_REF }

Write-Host "[jarvis] overlay stage - install_root=$InstallRoot ref=$Ref"

# Acquire/refresh the overlay checkout pinned to $Ref. fetch + checkout
# FETCH_HEAD works for branches AND full commit SHAs (finding #5 — a plain
# `git clone --branch <sha>` fails, and a silent fallback would unpin).
$fresh = -not (Test-Path (Join-Path $overlay '.git'))
if ($fresh) {
  New-Item -ItemType Directory -Force -Path $overlay | Out-Null
  git -C $overlay init --quiet
  if ($LASTEXITCODE -ne 0) { Write-Error "git init failed (exit $LASTEXITCODE)"; exit 1 }
  git -C $overlay remote add origin $repo
  if ($LASTEXITCODE -ne 0) { Write-Error "git remote add failed (exit $LASTEXITCODE)"; exit 1 }
}
git -C $overlay fetch --quiet --depth 1 origin $Ref
if ($LASTEXITCODE -ne 0) {
  if ($fresh) {
    Write-Error "could not fetch jarvis-agent@$Ref from $repo (exit $LASTEXITCODE)"
    exit 1
  }
  Write-Host "[jarvis] fetch of $Ref failed (offline?) - continuing with the existing checkout"
} else {
  git -C $overlay checkout --quiet -f FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { Write-Error "git checkout FETCH_HEAD failed (exit $LASTEXITCODE)"; exit 1 }
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
