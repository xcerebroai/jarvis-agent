#!/usr/bin/env bash
# jarvis-overlay.sh — the JARVIS overlay stage, bundled into JARVIS-Setup and
# run by the installer AFTER upstream install.ps1/​install.sh finishes its
# pristine Hermes install. It layers JARVIS on top of that install:
#   clone the jarvis-agent overlay -> install-jarvis.sh in overlay-only mode
#   (apply.sh branding + branded desktop build + JARVIS shortcuts + jarvis shim).
#
#   Usage:  jarvis-overlay.sh <install_root>       (install_root = .../hermes-agent)
#
# Idempotent: re-running repairs (git pull + install-jarvis.sh is idempotent).
set -euo pipefail

INSTALL_ROOT="${1:?usage: jarvis-overlay.sh <install_root>}"
HERMES_HOME_DIR="$(cd "$(dirname "$INSTALL_ROOT")" && pwd)"
OVERLAY_DIR="$HERMES_HOME_DIR/jarvis-agent"
REF="${JARVIS_OVERLAY_REF:-main}"
REPO="${JARVIS_OVERLAY_REPO:-https://github.com/xcerebroai/jarvis-agent}"

echo "[jarvis] overlay stage — install_root=$INSTALL_ROOT ref=$REF"

if [ -d "$OVERLAY_DIR/.git" ]; then
  echo "[jarvis] updating overlay checkout at $OVERLAY_DIR"
  git -C "$OVERLAY_DIR" fetch --depth 1 origin "$REF" \
    && git -C "$OVERLAY_DIR" checkout -f FETCH_HEAD
else
  echo "[jarvis] cloning overlay ($REF) into $OVERLAY_DIR"
  git clone --depth 1 --branch "$REF" "$REPO" "$OVERLAY_DIR" 2>/dev/null \
    || git clone --depth 1 "$REPO" "$OVERLAY_DIR"
fi

echo "[jarvis] applying overlay (overlay-only mode) against $INSTALL_ROOT"
exec env JARVIS_OVERLAY_ONLY=1 HERMES_SRC="$INSTALL_ROOT" \
  bash "$OVERLAY_DIR/install-jarvis.sh"
