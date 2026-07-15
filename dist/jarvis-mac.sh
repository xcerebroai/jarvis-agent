#!/usr/bin/env bash
# ============================================================================
#  JARVIS — macOS installer
#  Your AI Employee. Runs Your Business 24/7.
#
#  One command sets everything up:
#    curl -fsSL https://xcerebro.ai/jarvis/... (or download and run)
#    bash jarvis-mac.sh
#
#  What it does:
#    1. Checks / installs prerequisites (git, Python 3.11+, Node 20.19+/22.12+).
#    2. Clones Hermes Agent (the open-source engine) + the JARVIS overlay.
#    3. Runs the JARVIS installer: branding, desktop app build, launch points.
#
#  Flags:
#    --dry-run        Check prerequisites and print the plan; change nothing.
#    --dir <path>     Install location (default: ~/jarvis).
#    --no-desktop     Skip building the desktop app (CLI + gateways only).
# ============================================================================
set -euo pipefail

# --- Brand palette (ANSI truecolor, with graceful fallback) -----------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  B=$'\033[38;2;96;165;250m'; A=$'\033[38;2;59;130;246m'
  D=$'\033[38;2;107;114;128m'; G=$'\033[38;2;34;197;94m'
  R=$'\033[38;2;239;68;68m'; Z=$'\033[0m'; BLD=$'\033[1m'
else B=""; A=""; D=""; G=""; R=""; Z=""; BLD=""; fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s◆%s %s\n' "$A" "$Z" "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '%s!%s %s\n' "$R" "$Z" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

# --- Args -------------------------------------------------------------------
DRY_RUN=0; NO_DESKTOP=0; JARVIS_DIR="${JARVIS_DIR:-$HOME/jarvis}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-desktop) NO_DESKTOP=1 ;;
    --dir) shift; JARVIS_DIR="$1" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

HERMES_REPO="https://github.com/NousResearch/hermes-agent"
OVERLAY_REPO="https://github.com/xcerebroai/jarvis-agent"

banner() {
  printf '\n%s%s      ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗%s\n' "$BLD" "$B" "$Z"
  printf '%s%s      ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝%s\n' "$BLD" "$B" "$Z"
  printf '%s%s ██╗  ██║███████║██████╔╝╚██╗ ██╔╝██║███████╗%s\n' "$BLD" "$A" "$Z"
  printf '%s%s ╚█████╔╝██╔══██║██╔══██╗ ╚████╔╝ ██║╚════██║%s\n' "$BLD" "$A" "$Z"
  printf '%s%s  ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝%s\n' "$BLD" "$A" "$Z"
  printf '%s        Your AI Employee. Runs Your Business 24/7.%s\n\n' "$D" "$Z"
}

# --- Prerequisite helpers ---------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

brew_install() {  # brew_install <formula> <friendly-name>
  if have brew; then
    info "Installing $2 via Homebrew…"
    [ "$DRY_RUN" = 1 ] && { say "  (dry-run) brew install $1"; return 0; }
    brew install "$1"
  else
    die "$2 is required but not installed, and Homebrew was not found.
       Install Homebrew first:  https://brew.sh
       then re-run, or install $2 manually."
  fi
}

node_ok() {  # Node engine: ^20.19.0 || >=22.12.0
  have node || return 1
  local v; v="$(node -v 2>/dev/null | sed 's/^v//')"
  local maj="${v%%.*}"; local rest="${v#*.}"; local min="${rest%%.*}"
  [ -z "$maj" ] && return 1
  if [ "$maj" -eq 20 ] && [ "${min:-0}" -ge 19 ]; then return 0; fi
  if [ "$maj" -eq 22 ] && [ "${min:-0}" -ge 12 ]; then return 0; fi
  if [ "$maj" -gt 22 ]; then return 0; fi
  return 1
}

py_ok() {  # Python >= 3.11
  local py="$1"
  have "$py" || return 1
  "$py" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,11) else 1)' 2>/dev/null
}

check_prereqs() {
  info "Checking prerequisites…"

  # git — comes with Xcode Command Line Tools on macOS.
  if have git; then ok "git $(git --version | awk '{print $3}')"
  else
    warn "git not found."
    if [ "$DRY_RUN" = 1 ]; then say "  (dry-run) would run: xcode-select --install"
    else info "Requesting Xcode Command Line Tools (installs git)…"; xcode-select --install || true
      die "Re-run this script once the Command Line Tools finish installing."
    fi
  fi

  # Python 3.11+
  PYBIN=""
  for c in python3 python3.12 python3.11 python; do py_ok "$c" && { PYBIN="$c"; break; }; done
  if [ -n "$PYBIN" ]; then ok "Python $("$PYBIN" -c 'import platform;print(platform.python_version())') ($PYBIN)"
  else warn "Python 3.11+ not found."; brew_install python "Python 3.12"; PYBIN="python3"; fi

  # Node ^20.19 || >=22.12
  if node_ok; then ok "Node $(node -v)"
  else warn "A supported Node.js (^20.19 or >=22.12) was not found."; brew_install node@22 "Node.js 22"
    have node || { have /opt/homebrew/opt/node@22/bin/node && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"; }
  fi
}

# --- Clone + install --------------------------------------------------------
clone_or_update() {  # clone_or_update <url> <dir>
  if [ -d "$2/.git" ]; then
    info "Updating $(basename "$2")…"
    [ "$DRY_RUN" = 1 ] || git -C "$2" pull --ff-only --quiet || true
  else
    info "Cloning $(basename "$2")…"
    [ "$DRY_RUN" = 1 ] || git clone --depth 1 --quiet "$1" "$2"
  fi
}

main() {
  banner
  check_prereqs

  info "Install location: $JARVIS_DIR"
  if [ "$DRY_RUN" = 1 ]; then
    say ""
    info "Dry run — plan:"
    say "  1. git clone $HERMES_REPO   -> $JARVIS_DIR/hermes-agent"
    say "  2. git clone $OVERLAY_REPO  -> $JARVIS_DIR/jarvis-agent"
    say "  3. bash $JARVIS_DIR/jarvis-agent/install-jarvis.sh (HERMES_SRC=…/hermes-agent)"
    [ "$NO_DESKTOP" = 1 ] && say "     (desktop build skipped via --no-desktop)"
    say ""
    # Confirm the repos are reachable so a real run would succeed.
    for u in "$HERMES_REPO" "$OVERLAY_REPO"; do
      if git ls-remote "$u" >/dev/null 2>&1; then ok "reachable: $u"; else warn "NOT reachable: $u"; fi
    done
    ok "Dry run complete — no changes made."
    return 0
  fi

  mkdir -p "$JARVIS_DIR"
  clone_or_update "$HERMES_REPO"  "$JARVIS_DIR/hermes-agent"
  clone_or_update "$OVERLAY_REPO" "$JARVIS_DIR/jarvis-agent"

  info "Running the JARVIS installer…"
  [ "$NO_DESKTOP" = 1 ] && export JARVIS_SKIP_DESKTOP=1
  HERMES_SRC="$JARVIS_DIR/hermes-agent" bash "$JARVIS_DIR/jarvis-agent/install-jarvis.sh"

  say ""
  ok "JARVIS is installed."
  say "  Launch the ${BLD}JARVIS${Z} desktop app, or run ${BLD}jarvis${Z} in Terminal."
  say "  First launch will ask you to connect an AI provider key (and Telegram)."
  say "  Getting started: $OVERLAY_REPO#getting-started"
}

main "$@"
