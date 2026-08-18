#!/usr/bin/env bash
# Update-safe JARVIS desktop appearance default.
set -Eeuo pipefail

MODE="${1:-}"
SRC_ARG="${2:-}"
FEATURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$FEATURE_DIR/patches/tracked-files.patch"

resolve_src() {
  if [ -n "${HERMES_SRC:-}" ]; then printf '%s\n' "$HERMES_SRC"; return; fi
  if [ -n "$SRC_ARG" ]; then printf '%s\n' "$SRC_ARG"; return; fi
  return 1
}

patch_targets() {
  grep '^diff --git a/' "$PATCH" | sed 's|^diff --git a/||; s| b/.*$||'
}

feature_present() {
  local src="$1"
  grep -q "export const jarvisTheme" "$src/apps/desktop/src/themes/presets.ts" 2>/dev/null &&
  grep -q "DEFAULT_SKIN_NAME = 'jarvis'" "$src/apps/desktop/src/themes/presets.ts" 2>/dev/null &&
  grep -q "resetSkinPreferences" "$src/apps/desktop/src/app/settings/index.tsx" 2>/dev/null
}

do_apply() {
  local src="$1"
  echo "◆ jarvis-appearance — applying JARVIS default skin"
  if feature_present "$src" && ! git -C "$SRCG" apply --check --whitespace=nowarn < "$PATCH" 2>/dev/null; then
    echo "  ✓ appearance patch already applied"
  elif git -C "$SRCG" apply --check --whitespace=nowarn < "$PATCH" 2>/dev/null; then
    git -C "$SRCG" apply --whitespace=nowarn < "$PATCH"
    echo "  ✓ JARVIS appearance patch applied"
  else
    echo "  ✗ jarvis-appearance: UPSTREAM DRIFT — refusing a partial appearance install" >&2
    git -C "$SRCG" apply --check --whitespace=nowarn < "$PATCH" 2>&1 | sed 's/^/    /' >&2 || true
    return 1
  fi
}

do_revert() {
  local targets=() rel
  while IFS= read -r rel; do [ -n "$rel" ] && targets+=("$rel"); done < <(patch_targets)
  if [ "${#targets[@]}" -gt 0 ]; then
    git -C "$SRCG" checkout -- "${targets[@]}"
  fi
  echo "  ✓ JARVIS appearance feature reverted"
}

do_verify() {
  if feature_present "$1"; then
    echo "  ✓ JARVIS is the built-in first-launch/reset fallback"
  else
    echo "  ✗ JARVIS appearance default is not fully applied" >&2
    return 1
  fi
}

SRC="$(resolve_src || true)"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR: could not locate the Hermes source tree" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"
SRCG="$(cygpath -m "$SRC" 2>/dev/null || echo "$SRC")"

case "$MODE" in
  apply) do_apply "$SRC" ;;
  revert) do_revert ;;
  verify) do_verify "$SRC" ;;
  *) echo "usage: apply-feature.sh <apply|revert|verify> [HERMES_SRC]" >&2; exit 2 ;;
esac
