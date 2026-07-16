#!/usr/bin/env bash
# update-jarvis.sh — update Hermes upstream, then re-apply JARVIS branding.
#
# WHY THIS WRAPPER EXISTS (the core of the zero-conflict design):
#   `hermes update` is `git pull` with an auto-stash guard. If the JARVIS
#   string rewrites were left in the working tree, the pull would stash them
#   and then try to replay them onto new upstream — producing exactly the
#   merge conflicts this project exists to avoid.
#
#   So we do it in the only conflict-free order:
#     1. Revert the branded source files to pristine upstream.
#     2. `hermes update` — now a clean fast-forward: nothing to stash, nothing
#        to conflict.
#     3. Re-run apply.sh to re-brand the fresh upstream.
#
#   The CLI skin lives in ~/.hermes/skins/ (outside the repo) and is never
#   involved in any of this — it survives every update untouched.
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_python() {
  for c in "${HERMES_PYTHON:-}" python3 python py; do
    [ -z "$c" ] && continue
    command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  return 1
}
resolve_src() {
  if [ -n "${HERMES_SRC:-}" ]; then echo "$HERMES_SRC"; return 0; fi
  if [ -n "${1:-}" ]; then echo "$1"; return 0; fi
  local py; py="$(resolve_python || true)"
  [ -n "$py" ] && "$py" -c 'import os,hermes_cli;print(os.path.dirname(os.path.dirname(os.path.abspath(hermes_cli.__file__))))' 2>/dev/null && return 0
  return 1
}

# Resolve the runtime's Hermes home like hermes_constants.get_hermes_home():
#   $HERMES_HOME  ->  Windows: %LOCALAPPDATA%\hermes  ->  else ~/.hermes.
# The Setup binary (scripts/install.ps1) installs into %LOCALAPPDATA%\hermes on
# Windows, NOT ~/.hermes — so the branded-files manifest and backups must live
# there too, or the re-apply after an upstream update targets the wrong tree.
# Ask the installed hermes_constants first (source of truth); bash fallback.
resolve_hermes_home() {
  if [ -n "${HERMES_HOME:-}" ]; then printf '%s\n' "$HERMES_HOME"; return 0; fi
  local src="$1" py hh
  for py in "$src/venv/bin/python" "$src/venv/Scripts/python.exe" python3 python py; do
    if [ -x "$py" ] || command -v "$py" >/dev/null 2>&1; then
      hh="$(PYTHONPATH="$src" "$py" -c 'import hermes_constants;print(hermes_constants.get_hermes_home())' 2>/dev/null || true)"
      if [ -n "$hh" ]; then printf '%s\n' "${hh//\\//}"; return 0; fi
    fi
  done
  case "${OS:-}${OSTYPE:-}$(uname -s 2>/dev/null)" in
    *Windows_NT*|*msys*|*cygwin*|*MINGW*|*MSYS*)
      if [ -n "${LOCALAPPDATA:-}" ]; then printf '%s\n' "${LOCALAPPDATA//\\//}/hermes"; return 0; fi
      printf '%s\n' "$HOME/AppData/Local/hermes"; return 0 ;;
    *) printf '%s\n' "$HOME/.hermes"; return 0 ;;
  esac
}

SRC="$(resolve_src "${1:-}" || true)"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR: could not locate the Hermes source tree." >&2
  echo "       Pass it:  HERMES_SRC=/path/to/hermes-agent ./update-jarvis.sh" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"

echo "◆ JARVIS — updating Hermes upstream, then re-branding"
echo "  source : $SRC"

# --- 1. Revert ONLY the branded files so the pull is a clean fast-forward ---
# SCOPED to the files listed in the manifest apply.sh writes — never a blanket
# `git checkout -- .`. Local modifications to files the overlay does NOT brand
# are left completely untouched (hermes update stashes/restores them as usual).
# Any dirty branded file is backed up first, so nothing is ever lost silently.
HERMES_HOME="$(resolve_hermes_home "$SRC")"
MANIFEST="$HERMES_HOME/.jarvis/branded-files.txt"
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ ! -f "$MANIFEST" ]; then
    echo "  ! no branded-files manifest at $MANIFEST — running apply.sh once to build it."
    HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh" >/dev/null 2>&1 || true
  fi
  if [ -f "$MANIFEST" ]; then
    ts="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo now)"
    BK="$HERMES_HOME/.jarvis/backup-$ts"
    reverted=0; backed=0
    while IFS= read -r rel; do
      [ -z "$rel" ] && continue
      f="$SRC/$rel"; [ -f "$f" ] || continue
      # Back up ONLY if the file has changes that are NOT just JARVIS branding —
      # i.e. a genuine operator patch we'd otherwise discard. Normal updates
      # (pure branding) back up nothing. (Exclude such files via branding.exclude
      # for the reliable guarantee; this backup is a safety net.)
      # A line is "branding" if it mentions the brand (case-insensitive, so the
      # uppercase HERMES AGENT wordmark counts) or is a bare markup fragment
      # left by the multi-line "Hermes <br/> Agent" -> JARVIS collapse.
      nonbrand="$(git -C "$SRC" diff HEAD -- "$rel" 2>/dev/null \
                  | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
                  | grep -viE 'jarvis|hermes|◆|⚕' \
                  | grep -vE '^[+-][[:space:]]*(<br[[:space:]]*/?>|Agent)[[:space:]]*$' || true)"
      # (#17) Back up EVERY dirty branded file, not just ones the brand-word
      # filter flags: a user patch whose lines all happen to mention
      # hermes/jarvis would otherwise be reverted with no copy. The filter is
      # kept only to make the warning precise. Backups are capped at 3 below.
      if ! git -C "$SRC" diff --quiet HEAD -- "$rel" 2>/dev/null; then
        mkdir -p "$BK/$(dirname "$rel")" && cp -f "$f" "$BK/$rel" && backed=$((backed + 1))
        [ -n "$nonbrand" ] && echo "  ! branded file has a NON-branding local patch — backed up: $rel"
      fi
      git -C "$SRC" checkout -- "$rel" 2>/dev/null && reverted=$((reverted + 1)) || true
    done < "$MANIFEST"
    echo "  → reverted $reverted branded file(s) to pristine; backed up $backed dirty one(s)"
    [ "$backed" -gt 0 ] && echo "    backup: $BK"
    echo "    (files NOT branded by JARVIS are untouched; if you locally patch a"
    echo "     branded file, add it to branding.exclude so it is never reverted.)"
    # Keep only the 3 most recent backups.
    ls -1dt "$HERMES_HOME/.jarvis"/backup-* 2>/dev/null | tail -n +4 | while IFS= read -r old; do
      rm -rf "$old"
    done
  fi
else
  echo "  ! $SRC is not a git checkout — skipping revert."
  echo "    If 'hermes update' reinstalls (pip) it will overwrite branding;"
  echo "    apply.sh re-brands afterward regardless."
fi

# --- 2. Update Hermes ------------------------------------------------------
echo "  → running 'hermes update'…"
UPDATER="$(command -v hermes 2>/dev/null || command -v jarvis 2>/dev/null || true)"
if [ -z "$UPDATER" ]; then
  echo "ERROR: neither 'hermes' nor 'jarvis' found on PATH to run the update." >&2
  exit 127
fi
# JARVIS_NO_UPDATE_WRAP=1 stops the jarvis shim's `update` interception from
# recursing back here when $UPDATER resolves to the jarvis shim (finding #9).
# (#7) On failure, re-apply branding BEFORE exiting: step 1 reverted the
# branded files, and dying here would leave the install as pristine Hermes.
rc=0
JARVIS_NO_UPDATE_WRAP=1 "$UPDATER" update "${@:2}" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "  ✗ hermes update failed (exit $rc) — re-applying branding so the tree isn't left reverted/unbranded." >&2
  HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh" || true
  exit "$rc"
fi

# --- 3. Re-apply JARVIS branding to the fresh upstream ---------------------
echo "  → re-applying JARVIS overlay…"
HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh"

# --- 4. Rebuild the desktop app so it isn't left rebuilt un-branded ---------
# `hermes update` (step 2) runs `hermes desktop --build-only` from PRISTINE
# source BEFORE our re-apply, so without this the running desktop app would be
# a freshly-built HERMES. Rebuild once more from the now-rebranded source.
# Only if the desktop was actually built on this machine (release/ present).
# (#8) macOS output is release/mac*/ (no "-unpacked" suffix) — the old
# *-unpacked-only glob skipped the rebuild on every Mac, leaving the desktop
# stale/unbranded after updates.
DESK_RELEASE="$SRC/apps/desktop/release"
if [ -d "$DESK_RELEASE" ] && { ls -d "$DESK_RELEASE"/*-unpacked >/dev/null 2>&1 || ls -d "$DESK_RELEASE"/mac* >/dev/null 2>&1; }; then
  echo
  echo "◆ Rebuilding JARVIS desktop — this takes a few minutes, don't close."
  if "$UPDATER" desktop --build-only "${@:2}"; then
    echo "  ✓ desktop rebuilt from JARVIS-branded source"
    HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh" --verify-build "$SRC" || \
      echo "  ⚠ built desktop bundle still carries brand strings — see warning above"
    # (#24c) macOS: the /Applications launch point is a real COPY of the
    # bundle (never a symlink — Launchpad/helper-app resolution both break),
    # so a rebuild must refresh it or users keep launching the stale app.
    case "$(uname -s)" in
      Darwin*)
        app="$(ls -d "$DESK_RELEASE"/mac*/Hermes.app 2>/dev/null | head -1)"
        if [ -n "$app" ]; then
          refreshed=0
          for tgt in "/Applications/JARVIS.app" "$HOME/Applications/JARVIS.app"; do
            { [ -e "$tgt" ] || [ -L "$tgt" ]; } || continue
            rm -rf "$tgt"
            ditto "$app" "$tgt" 2>/dev/null \
              && { echo "  ✓ refreshed $tgt (ditto copy)"; refreshed=1; } \
              || echo "  ⚠ could not refresh $tgt"
          done
          if [ "$refreshed" -eq 0 ]; then
            appdir="/Applications"; [ -w "$appdir" ] || appdir="$HOME/Applications"
            mkdir -p "$appdir" 2>/dev/null || true
            ditto "$app" "$appdir/JARVIS.app" 2>/dev/null \
              && echo "  ✓ JARVIS.app -> $appdir/JARVIS.app (real copy)" \
              || echo "  ⚠ could not install JARVIS.app into $appdir"
          fi
        fi ;;
    esac
  else
    echo "  ⚠ desktop rebuild failed — the app may show HERMES until you run:"
    echo "      $UPDATER desktop --build-only"
  fi
else
  echo "  · desktop app was never built on this machine — skipping rebuild."
  echo "    (Build it any time with:  $UPDATER desktop --build-only)"
fi

echo "◆ JARVIS — update complete"
