<#
============================================================================
  JARVIS - Windows installer
  Your AI Employee. Runs Your Business 24/7.

  Run in PowerShell:
    powershell -ExecutionPolicy Bypass -File jarvis-windows.ps1

  What it does:
    1. Checks / installs prerequisites (Git, Python 3.11+, Node 20.19+/22.12+)
       via winget.
    2. Clones Hermes Agent (the open-source engine) + the JARVIS overlay.
    3. Runs the JARVIS installer under Git Bash: branding, desktop app build,
       Start-Menu / desktop shortcuts.

  Flags:
    -DryRun       Check prerequisites and print the plan; change nothing.
    -NoDesktop    Skip building the desktop app (CLI + gateways only).
    -Dir <path>   Install location (default: %USERPROFILE%\jarvis).
============================================================================
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$NoDesktop,
  [string]$Dir = "$env:USERPROFILE\jarvis",
  [string]$OverlayDir = ''   # use an existing jarvis-agent checkout instead of cloning (CI/testing)
)

$ErrorActionPreference = 'Stop'

# --- UTF-8 console (so the banner / box-art renders, not mojibake) ----------
try { chcp 65001 > $null } catch {}
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  $env:PYTHONUTF8 = '1'
  $env:PYTHONIOENCODING = 'utf-8'
} catch {}

$HermesRepo  = 'https://github.com/NousResearch/hermes-agent'
$OverlayRepo = 'https://github.com/xcerebroai/jarvis-agent'

function Info($m) { Write-Host "* $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "X  $m" -ForegroundColor Red; exit 1 }

function Show-Banner {
  $b = [ConsoleColor]::Blue
  Write-Host ""
  Write-Host "      JARVIS" -ForegroundColor Cyan
  Write-Host "      Your AI Employee. Runs Your Business 24/7." -ForegroundColor DarkGray
  Write-Host ""
}

function Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable('Path','Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Winget-Install($id, $name) {
  if (-not (Have 'winget')) {
    Die "$name is required but not installed, and winget was not found.`n   Install $name manually, or update to a Windows build with App Installer, then re-run."
  }
  Info "Installing $name via winget ($id)..."
  if ($DryRun) { Write-Host "   (dry-run) winget install --id $id"; return }
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
  # (#12) winget can fail without admin rights, behind corporate policy, or on
  # source-agreement errors — continuing would cascade into confusing failures
  # ("git not recognized") much later.
  if ($LASTEXITCODE -ne 0) {
    Die "winget could not install $name (exit $LASTEXITCODE). Install $name manually, then re-run this installer."
  }
  Refresh-Path
}

function Node-Ok {
  if (-not (Have 'node')) { return $false }
  $v = (node -v) -replace '^v',''
  $p = $v.Split('.')
  $maj = [int]$p[0]; $min = [int]$p[1]
  if ($maj -eq 20 -and $min -ge 19) { return $true }
  if ($maj -eq 22 -and $min -ge 12) { return $true }
  if ($maj -gt 22) { return $true }
  return $false
}

function Py-Ok($py) {
  if (-not (Have $py)) { return $false }
  try { & $py -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,11) else 1)'; return $? } catch { return $false }
}

function Find-Bash {
  $cands = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $g = Get-Command bash -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  return $null
}

function Check-Prereqs {
  Info "Checking prerequisites..."

  if (Have 'git') { Ok ("git " + ((git --version) -replace 'git version ','')) }
  else { Warn "Git not found."; Winget-Install 'Git.Git' 'Git' }

  # Probe 'py' and 'python3' before bare 'python' so we don't trigger the
  # Windows Store "Python was not found" app-execution-alias noise.
  $script:PyBin = $null
  foreach ($c in @('py','python3','python')) { if (Py-Ok $c) { $script:PyBin = $c; break } }
  if ($script:PyBin) { Ok ("Python " + (& $script:PyBin -c 'import platform;print(platform.python_version())')) }
  else { Warn "Python 3.11+ not found."; Winget-Install 'Python.Python.3.12' 'Python 3.12'; $script:PyBin = 'python' }

  if (Node-Ok) { Ok ("Node " + (node -v)) }
  else { Warn "A supported Node.js (^20.19 or >=22.12) was not found."; Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js 22 LTS' }
}

function To-Posix($winPath) { return ($winPath -replace '\\','/') }

function Clone-OrUpdate($url, $dir) {
  if (Test-Path (Join-Path $dir '.git')) {
    Info "Updating $(Split-Path $dir -Leaf)..."
    if (-not $DryRun) { git -C $dir pull --ff-only --quiet }
  } else {
    Info "Cloning $(Split-Path $dir -Leaf)..."
    if (-not $DryRun) { git clone --depth 1 --quiet $url $dir }
  }
}

# --- Main -------------------------------------------------------------------
Show-Banner
Check-Prereqs

Info "Install location: $Dir"

if ($DryRun) {
  Write-Host ""
  Info "Dry run - plan:"
  Write-Host "  1. git clone $HermesRepo   -> $Dir\hermes-agent"
  Write-Host "  2. git clone $OverlayRepo  -> $Dir\jarvis-agent"
  Write-Host "  3. Git Bash: install-jarvis.sh (HERMES_SRC=...\hermes-agent)"
  if ($NoDesktop) { Write-Host "     (desktop build skipped via -NoDesktop)" }
  Write-Host ""
  foreach ($u in @($HermesRepo, $OverlayRepo)) {
    # (#16) Under EAP=Stop in PS 5.1, redirecting a native command's stderr
    # (*>/2>) wraps it in terminating NativeCommandErrors — the unreachable
    # branch would throw instead of warning. Probe by exit code, EAP relaxed.
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git ls-remote $u 2>&1 | Out-Null
    $reachable = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEAP
    if ($reachable) { Ok "reachable: $u" } else { Warn "NOT reachable: $u" }
  }
  $bash = Find-Bash
  if ($bash) { Ok "Git Bash found: $bash" } else { Warn "Git Bash not found (Git install provides it)" }
  Ok "Dry run complete - no changes made."
  exit 0
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# hermes/jarvis link their commands into ~/.local/bin — make sure it exists and
# is on the persisted Windows user PATH so `jarvis`/`hermes` resolve in new shells.
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $LocalBin | Out-Null
# (#14) A fresh profile can have a NULL user PATH — calling .TrimEnd() on it
# throws under EAP=Stop. Coerce to [string] and branch.
[string]$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if (-not (($userPath -split ';') -contains $LocalBin)) {
  $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $LocalBin } else { $LocalBin }
  [Environment]::SetEnvironmentVariable('Path', $newPath.TrimStart(';'), 'User')
  Info "Added $LocalBin to your user PATH (new terminals will pick it up)."
}
Clone-OrUpdate $HermesRepo (Join-Path $Dir 'hermes-agent')
if ($OverlayDir) {
  Info "Using existing overlay checkout: $OverlayDir"
  $overlayPath = $OverlayDir
} else {
  Clone-OrUpdate $OverlayRepo (Join-Path $Dir 'jarvis-agent')
  $overlayPath = (Join-Path $Dir 'jarvis-agent')
}

$bash = Find-Bash
if (-not $bash) { Die "Git Bash (bash.exe) not found. Reinstall Git for Windows, then re-run." }

$hermesPosix  = To-Posix (Join-Path $Dir 'hermes-agent')
$overlayPosix = To-Posix $overlayPath
$skip = ''
if ($NoDesktop) { $skip = "JARVIS_SKIP_DESKTOP=1 " }

Info "Running the JARVIS installer under Git Bash..."
$cmd = "cd '$overlayPosix' && ${skip}HERMES_SRC='$hermesPosix' bash ./install-jarvis.sh"
& $bash -lc $cmd
if (-not $?) { Die "The JARVIS installer reported an error. See the output above." }

Write-Host ""
Ok "JARVIS is installed."
Write-Host "  Launch the JARVIS app from the Start Menu / desktop shortcut,"
Write-Host "  or run  jarvis  in a new terminal."
Write-Host "  First launch will ask you to connect an AI provider key (and Telegram)."
Write-Host "  Getting started: $OverlayRepo#getting-started"
