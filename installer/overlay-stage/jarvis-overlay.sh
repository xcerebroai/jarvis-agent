#!/usr/bin/env bash
# jarvis-overlay.sh — the JARVIS overlay stage (embedded in JARVIS-Setup),
# run by the installer AFTER upstream install.sh finishes its pristine Hermes
# install. Acquires the jarvis-agent overlay pinned to a ref, then runs
# install-jarvis.sh in overlay-only mode (apply.sh branding + branded desktop
# build + JARVIS launch points + jarvis command shim).
#
#   Usage:  jarvis-overlay.sh <install_root> [<ref>]
#
# Pinning (finding #5): fetch + checkout FETCH_HEAD works for branches AND
# full commit SHAs; `git clone --branch <sha>` does not, and a silent fallback
# would unpin. Fresh acquire fails LOUDLY; a re-run with an existing checkout
# tolerates a fetch failure (offline repair) and uses what it has.
# Idempotent.
set -euo pipefail

INSTALL_ROOT="${1:?usage: jarvis-overlay.sh <install_root> [<ref>]}"
REF="${2:-${JARVIS_OVERLAY_REF:-main}}"
HERMES_HOME_DIR="$(cd "$(dirname "$INSTALL_ROOT")" && pwd)"
OVERLAY_DIR="$HERMES_HOME_DIR/jarvis-agent"
REPO="${JARVIS_OVERLAY_REPO:-https://github.com/xcerebroai/jarvis-agent}"

echo "[jarvis] overlay stage — install_root=$INSTALL_ROOT ref=$REF"

fresh=0
if [ ! -d "$OVERLAY_DIR/.git" ]; then
  fresh=1
  mkdir -p "$OVERLAY_DIR"
  git -C "$OVERLAY_DIR" init --quiet
  git -C "$OVERLAY_DIR" remote add origin "$REPO"
fi
if git -C "$OVERLAY_DIR" fetch --quiet --depth 1 origin "$REF"; then
  git -C "$OVERLAY_DIR" checkout --quiet -f FETCH_HEAD
elif [ "$fresh" = 1 ]; then
  echo "[jarvis] ERROR: could not fetch jarvis-agent@$REF from $REPO" >&2
  exit 1
else
  echo "[jarvis] fetch of $REF failed (offline?) — continuing with the existing checkout"
fi

echo "[jarvis] applying overlay (overlay-only mode) against $INSTALL_ROOT"
exec env JARVIS_OVERLAY_ONLY=1 HERMES_SRC="$INSTALL_ROOT" \
  bash "$OVERLAY_DIR/install-jarvis.sh"
