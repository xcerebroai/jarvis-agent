#!/usr/bin/env bash
# apply-feature.sh — apply / revert the Realtime voice feature layer on a Hermes
# Agent checkout. This is the overlay's SECOND mechanism (alongside branding):
# it layers a configurable OpenAI Realtime speech-to-speech voice assistant onto
# an unmodified upstream tree, so `hermes update` still pulls clean upstream.
#
# Shape of this feature layer (features/realtime-voice/):
#   files/            new source files, copied verbatim into the upstream tree
#   patches/tracked-files.patch   a focused git-apply patch for tracked files
#   new-files.manifest            the exact copied paths (for a scoped revert)
#   config/voice.realtime.defaults.yaml   documented config defaults (seeded)
#
# Contracts (mirroring the branding overlay's invariants):
#   * APPLY is idempotent and observable, and FAILS LOUDLY on upstream drift
#     rather than silently shipping partial voice support.
#   * REVERT restores an EXACT clean upstream: tracked files via `git checkout`
#     (never a blanket checkout — only this feature's declared paths), and the
#     overlay-owned untracked files removed by exact manifest path only.
#   * Config defaults are seeded NON-DESTRUCTIVELY — an operator's existing
#     `voice.realtime` block / voice identity / key is never overwritten.
#
# Usage:  apply-feature.sh <apply|revert|verify> [HERMES_SRC]
# Source resolution:  $HERMES_SRC -> $2 -> autodetect via hermes_cli.
set -Eeuo pipefail

MODE="${1:-}"; SRC_ARG="${2:-}"
FEATURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY_DIR="$(cd "$FEATURE_DIR/../.." && pwd)"
PATCH="$FEATURE_DIR/patches/tracked-files.patch"
NEW_MANIFEST="$FEATURE_DIR/new-files.manifest"
CONFIG_DEFAULTS="$FEATURE_DIR/config/voice.realtime.defaults.yaml"

export PYTHONUTF8=1 PYTHONIOENCODING=utf-8

_fail() {
  local rc=$?
  echo "" >&2
  echo "  ##################################################################" >&2
  echo "  # realtime-voice feature FAILED — exit $rc" >&2
  echo "  #   line:    ${BASH_LINENO[0]:-?}   command: ${BASH_COMMAND}" >&2
  echo "  ##################################################################" >&2
  exit "$rc"
}
trap _fail ERR

resolve_python() {
  local c
  for c in "${HERMES_PYTHON:-}" "${SRC:-/nonexistent}/venv/bin/python" \
           "${SRC:-/nonexistent}/venv/Scripts/python.exe" python3 py python; do
    [ -z "$c" ] && continue
    if { [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; } && "$c" -c 'import yaml' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

resolve_src() {
  if [ -n "${HERMES_SRC:-}" ]; then echo "$HERMES_SRC"; return 0; fi
  if [ -n "$SRC_ARG" ]; then echo "$SRC_ARG"; return 0; fi
  local py; py="$(resolve_python || true)"
  if [ -n "$py" ]; then
    "$py" - <<'PY' 2>/dev/null && return 0
import os, sys
try:
    import hermes_cli
    print(os.path.dirname(os.path.dirname(os.path.abspath(hermes_cli.__file__))))
except Exception:
    sys.exit(1)
PY
  fi
  return 1
}

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

# Tracked files the patch touches (drives the scoped `git checkout` revert).
patch_targets() {
  grep '^diff --git a/' "$PATCH" | sed 's|^diff --git a/||; s| b/.*$||'
}

# Sentinel probe: is the feature already present in the tree? Uses feature-unique
# tokens in brand-free regions, so it stays true even after branding rewrites
# other lines of the same files. Robust where a raw `git apply --check` would be
# confused by the branding overlay editing adjacent lines.
feature_present() {
  local src="$1"
  grep -q "hermes:voice-active" "$src/apps/desktop/electron/main.ts" 2>/dev/null &&
  grep -q "setVoiceActive" "$src/apps/desktop/electron/stream-throttle.ts" 2>/dev/null &&
  grep -q "mintRealtimeToken" "$src/apps/desktop/src/api/realtime-voice.ts" 2>/dev/null &&
  grep -q "api/realtime-voice" "$src/apps/desktop/src/hermes.ts" 2>/dev/null &&
  grep -q "/api/audio/realtime/token" "$src/hermes_cli/web_server.py" 2>/dev/null &&
  grep -q "voice-supervisor" "$src/apps/desktop/src/main.tsx" 2>/dev/null &&
  grep -q "def audio_input_rms" "$src/tools/wake_word.py" 2>/dev/null &&
  [ -f "$src/apps/desktop/src/lib/voice/voice-supervisor.ts" ] &&
  [ -f "$src/hermes_cli/realtime_voice.py" ]
}

copy_new_files() {
  local src="$1" rel n=0
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    mkdir -p "$src/$(dirname "$rel")"
    cp -f "$FEATURE_DIR/files/$rel" "$src/$rel"
    n=$((n + 1))
  done < "$NEW_MANIFEST"
  echo "  ✓ copied $n feature source file(s) into the tree"
}

remove_new_files() {
  local src="$1" rel n=0
  # Remove ONLY the exact declared paths — never anything the operator added.
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    if [ -f "$src/$rel" ]; then rm -f "$src/$rel"; n=$((n + 1)); fi
  done < "$NEW_MANIFEST"
  # Prune the now-empty feature dir (only if empty — never rmdir operator files).
  rmdir "$src/apps/desktop/src/lib/voice" 2>/dev/null || true
  echo "  ✓ removed $n overlay-owned feature file(s)"
}

seed_config_defaults() {
  local src="$1" home py home_g defaults_g
  home="$(resolve_hermes_home "$src")"
  py="$(resolve_python || true)"
  [ -z "$py" ] && { echo "  · no python+pyyaml — skipped config seed (set voice.realtime manually)"; return 0; }
  # Native Windows python cannot open an MSYS "/c/..." path; hand it mixed
  # "C:/..." paths (a no-op on Linux/macOS where cygpath is absent).
  home_g="$(cygpath -m "$home" 2>/dev/null || echo "$home")"
  defaults_g="$(cygpath -m "$CONFIG_DEFAULTS" 2>/dev/null || echo "$CONFIG_DEFAULTS")"
  HERMES_HOME="$home_g" DEFAULTS="$defaults_g" "$py" - <<'PY'
import io, os
try:
    import yaml
except Exception:
    raise SystemExit(0)
home = os.environ["HERMES_HOME"]
path = os.path.join(home, "config.yaml")
defaults = yaml.safe_load(open(os.environ["DEFAULTS"], encoding="utf-8")) or {}
seed = (defaults.get("voice") or {}).get("realtime") or {}
data = {}
if os.path.isfile(path):
    with io.open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
if not isinstance(data, dict):
    data = {}
voice = data.get("voice")
if not isinstance(voice, dict):
    voice = {}
changed = False
# NON-DESTRUCTIVE: only seed when the operator has NO voice.realtime block.
if isinstance(voice.get("realtime"), dict):
    print("  · config voice.realtime already set by operator (left as-is)")
else:
    voice["realtime"] = seed
    data["voice"] = voice
    changed = True
    print("  ✓ seeded documented voice.realtime defaults into config.yaml")

# The summon phrase (wake_word) seeds PER-KEY: each key lands only when the
# operator has not set it, so an explicit different model — or a deliberate
# enabled:false — is never overwritten. Block-level seeding would skip
# machines that merely toggled /wake once (a bare {enabled: true}), leaving
# them listening for upstream's hey_hermes instead of the product phrase.
wake_seed = defaults.get("wake_word") or {}
if wake_seed:
    wake_changed = False
    wake = data.get("wake_word")
    if not isinstance(wake, dict):
        wake = {}
    for key in ("enabled", "phrase"):
        if key in wake_seed and key not in wake:
            wake[key] = wake_seed[key]
            wake_changed = True
    oww_seed = wake_seed.get("openwakeword") or {}
    oww = wake.get("openwakeword")
    if not isinstance(oww, dict):
        oww = {}
    if "model" in oww_seed and "model" not in oww:
        oww["model"] = oww_seed["model"]
        wake_changed = True
    if oww:
        wake["openwakeword"] = oww
    if wake:
        data["wake_word"] = wake
    if wake_changed:
        changed = True
        print("  ✓ wake_word summon phrase seeded (absent keys only)")
    else:
        print("  · wake_word already fully set by operator (left as-is)")

if changed:
    os.makedirs(home, exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
PY
}

do_apply() {
  local src="$1"
  echo "◆ realtime-voice — applying feature"
  echo "  source : $src"
  [ -f "$PATCH" ] || { echo "ERROR: patch not found at $PATCH" >&2; exit 1; }

  # 1. New source files (idempotent overwrite).
  copy_new_files "$src"

  # 2. Tracked-file patch (fed on stdin so its path needs no MSYS conversion).
  if feature_present "$src" && ! git -C "$SRCG" apply --check --whitespace=nowarn < "$PATCH" 2>/dev/null; then
    echo "  ✓ tracked-file patch already applied (idempotent no-op)"
  elif git -C "$SRCG" apply --check --whitespace=nowarn < "$PATCH" 2>/dev/null; then
    git -C "$SRCG" apply --whitespace=nowarn < "$PATCH"
    echo "  ✓ tracked-file patch applied ($(patch_targets | grep -c .) file(s))"
  else
    echo "" >&2
    echo "  ##################################################################" >&2
    echo "  # realtime-voice: UPSTREAM DRIFT — the tracked-file patch does not" >&2
    echo "  # apply to this Hermes checkout, and the feature is not already" >&2
    echo "  # present. Refusing to ship PARTIAL voice support." >&2
    echo "  #" >&2
    echo "  # Rebuild patches/tracked-files.patch against current upstream" >&2
    echo "  # (see features/realtime-voice/README.md) then re-run apply." >&2
    echo "  # Files that no longer match:" >&2
    git -C "$SRCG" apply --check --whitespace=nowarn < "$PATCH" 2>&1 | sed 's/^/  #   /' >&2 || true
    echo "  ##################################################################" >&2
    # Do not leave orphaned new files behind on a drift abort.
    remove_new_files "$src" >/dev/null 2>&1 || true
    exit 1
  fi

  # 3. Config defaults (non-destructive).
  seed_config_defaults "$src"

  # Pre-fetch the hey_jarvis wake model so the first "Jarvis" works without
  # a first-arm download stall. Best-effort by design: needs the install's
  # venv (openwakeword lives there, not in any system python) and network;
  # when either is missing the runtime downloads it on first wake.start
  # instead (tools/wake_word.py) — a slower first arm, never a failure.
  for _vp in "$src/venv/bin/python" "$src/venv/Scripts/python.exe"; do
    [ -x "$_vp" ] || continue
    if "$_vp" - <<'PY' 2>/dev/null
import openwakeword.utils
openwakeword.utils.download_models(["hey_jarvis"])
PY
    then echo "  ✓ hey_jarvis wake model pre-fetched"
    else echo "  · hey_jarvis pre-fetch skipped (offline or engine absent) — fetched on first arm instead"
    fi
    break
  done

  echo "  ✓ realtime-voice feature applied"
}

do_revert() {
  local src="$1"
  echo "◆ realtime-voice — reverting to pristine upstream"
  if git -C "$SRCG" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local targets=() rel
    while IFS= read -r rel; do [ -n "$rel" ] && targets+=("$rel"); done < <(patch_targets)
    if [ "${#targets[@]}" -gt 0 ]; then
      # Scoped checkout — pristine ONLY the feature's declared tracked files.
      git -C "$SRCG" checkout -- "${targets[@]}" 2>/dev/null || true
      echo "  ✓ restored ${#targets[@]} tracked file(s) to pristine upstream"
    fi
  else
    echo "  · $src is not a git checkout — skipping tracked-file revert"
  fi
  remove_new_files "$src"
  echo "  ✓ realtime-voice feature reverted (clean upstream)"
}

do_verify() {
  local src="$1" rc=0 rel
  echo "◆ realtime-voice — verify applied state"
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    [ -f "$src/$rel" ] || { echo "  ✗ missing feature file: $rel"; rc=1; }
  done < "$NEW_MANIFEST"
  feature_present "$src" || { echo "  ✗ tracked-file patch not detected in tree"; rc=1; }
  if [ "$rc" -eq 0 ]; then echo "  ✓ feature files installed + tracked patch present"; fi
  return "$rc"
}

SRC="$(resolve_src || true)"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR: could not locate the Hermes source tree." >&2
  echo "       Pass it:  HERMES_SRC=/path/to/hermes-agent apply-feature.sh $MODE" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"
# Git-for-Windows' native git.exe cannot chdir into an MSYS "/c/..." path via
# `git -C`; give it a mixed "C:/..." path when cygpath is available (a no-op on
# Linux/macOS). Every git invocation below uses $SRCG, and the patch is fed on
# stdin so its path never needs conversion either.
SRCG="$(cygpath -m "$SRC" 2>/dev/null || echo "$SRC")"

case "$MODE" in
  apply)  do_apply "$SRC" ;;
  revert) do_revert "$SRC" ;;
  verify) do_verify "$SRC" ;;
  *) echo "usage: apply-feature.sh <apply|revert|verify> [HERMES_SRC]" >&2; exit 2 ;;
esac
