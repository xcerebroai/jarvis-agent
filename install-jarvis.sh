#!/usr/bin/env bash
# install-jarvis.sh — JARVIS-branded installer that wraps Hermes's setup.
#
# Flow:
#   1. Show the JARVIS banner (UTF-8 with automatic ASCII/color fallbacks).
#   2. Run the real setup-hermes.sh (unmodified) to install Hermes.
#   3. Install the `jarvis` command shim onto PATH.
#   4. Run apply.sh to brand the fresh install (skin + string rewrites).
#   5. Print branded next steps.
#
# The underlying Hermes install is left pristine; all branding is layered on
# top so `hermes update` (via update-jarvis.sh) always pulls clean upstream.
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

resolve_python() {
  for c in "${HERMES_PYTHON:-}" python3 python py; do
    [ -z "$c" ] && continue
    command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  return 1
}

# --- Resolve the Hermes source tree ---------------------------------------
# $HERMES_SRC -> $1 -> a sibling/cwd hermes-agent checkout containing setup.
resolve_src() {
  if [ -n "${HERMES_SRC:-}" ]; then echo "$HERMES_SRC"; return 0; fi
  if [ -n "${1:-}" ]; then echo "$1"; return 0; fi
  local d
  for d in "$PWD" "$PWD/hermes-agent" "$OVERLAY_DIR/../hermes-agent" "$OVERLAY_DIR/../../hermes-agent"; do
    [ -f "$d/setup-hermes.sh" ] && { (cd "$d" && pwd); return 0; }
  done
  return 1
}

SRC="$(resolve_src "${1:-}" || true)"
if [ -z "$SRC" ] || [ ! -f "$SRC/setup-hermes.sh" ]; then
  echo "ERROR: could not find hermes-agent/setup-hermes.sh." >&2
  echo "       Clone https://github.com/NousResearch/hermes-agent first, then:" >&2
  echo "       HERMES_SRC=/path/to/hermes-agent ./install-jarvis.sh" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"

# --- 1. Branded banner -----------------------------------------------------
if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  PYB="$(command -v python3 || command -v python)"
  "$PYB" "$OVERLAY_DIR/bin/jarvis-banner" || true
fi
echo "  Installing JARVIS — your AI employee. Wrapping Hermes Agent setup…"
echo

# --- 2. Run the real Hermes setup (unmodified) -----------------------------
echo "◆ Running Hermes setup (setup-hermes.sh)…"
( cd "$SRC" && bash ./setup-hermes.sh "${@:2}" )

# --- 3. Install the `jarvis` shim onto PATH --------------------------------
BIN_DIR="${JARVIS_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
cp -f "$OVERLAY_DIR/bin/jarvis" "$BIN_DIR/jarvis"
chmod +x "$BIN_DIR/jarvis" 2>/dev/null || true
cp -f "$OVERLAY_DIR/bin/jarvis-banner" "$BIN_DIR/jarvis-banner"
chmod +x "$BIN_DIR/jarvis-banner" 2>/dev/null || true
case "${OS:-}${OSTYPE:-}" in
  *Windows_NT*|*msys*|*cygwin*|*win32*)
    cp -f "$OVERLAY_DIR/bin/jarvis.cmd" "$BIN_DIR/jarvis.cmd" ;;
esac
echo "◆ installed 'jarvis' command -> $BIN_DIR/jarvis"

# --- 4. Apply JARVIS branding ---------------------------------------------
echo "◆ Applying JARVIS branding…"
HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh"

# --- 5. Branded next steps -------------------------------------------------
cat <<'EOF'

◆ JARVIS is ready.
    jarvis                 # start JARVIS
    jarvis status          # check configuration
    jarvis gateway         # run the messaging gateway
    ./update-jarvis.sh     # update Hermes upstream and re-apply branding

  Note: `jarvis` and `hermes` are the same runtime; your data stays in
  ~/.hermes (paths are intentionally left as-is so the tooling keeps working).
EOF
