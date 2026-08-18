#!/usr/bin/env bash
# Validate JARVIS appearance apply/idempotency/revert/drift on current upstream.
set -uo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEATURE="$OVERLAY_DIR/features/jarvis-appearance/apply-feature.sh"
UPSTREAM="https://github.com/NousResearch/hermes-agent"
PASS=0; FAIL=0
ok() { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

case "${OS:-}${OSTYPE:-}$(uname -s 2>/dev/null)" in
  *Windows_NT*|*msys*|*cygwin*|*MINGW*|*MSYS*) ROOT="${LOCALAPPDATA//\\//}/Temp" ;;
  *) ROOT="${TMPDIR:-/tmp}" ;;
esac
mkdir -p "$ROOT"
WORK="$(mktemp -d "$ROOT/jarvis-appearance-test.XXXXXX")"
cleanup() { [ -n "${KEEP:-}" ] || rm -rf "$WORK"; }
trap cleanup EXIT
SRC="$WORK/hermes-agent"

echo "▶ cloning current upstream…"
git clone --quiet --depth 1 "$UPSTREAM" "$SRC" || exit 2
SRCG="$(cygpath -m "$SRC" 2>/dev/null || echo "$SRC")"
BASELINE="$(git -C "$SRCG" status --porcelain | sort)"

OUT="$(HERMES_SRC="$SRC" bash "$FEATURE" apply "$SRC" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "apply succeeds" || bad "apply failed"
grep -q "DEFAULT_SKIN_NAME = 'jarvis'" "$SRC/apps/desktop/src/themes/presets.ts" && ok "JARVIS is the source fallback" || bad "fallback not changed"
grep -q "jarvis: jarvisTheme" "$SRC/apps/desktop/src/themes/presets.ts" && ok "JARVIS is built into Appearance" || bad "theme not built in"
grep -q "resetSkinPreferences()" "$SRC/apps/desktop/src/app/settings/index.tsx" && ok "reset-to-default is wired" || bad "reset hook missing"
HERMES_SRC="$SRC" bash "$FEATURE" verify "$SRC" >/dev/null 2>&1 && ok "verify succeeds" || bad "verify failed"

OUT2="$(HERMES_SRC="$SRC" bash "$FEATURE" apply "$SRC" 2>&1)"
echo "$OUT2" | grep -q 'already applied' && ok "second apply is idempotent" || bad "second apply not idempotent"

HERMES_SRC="$SRC" bash "$FEATURE" revert "$SRC" >/dev/null 2>&1
AFTER="$(git -C "$SRCG" status --porcelain | sort)"
[ "$AFTER" = "$BASELINE" ] && ok "revert restores exact upstream baseline" || bad "revert left residue"

# Break the presets anchor and prove drift is loud and non-partial.
perl -0777 -i -pe "s/const PSYCHE_WARM = '#FFE6CB'\n//" "$SRC/apps/desktop/src/themes/presets.ts"
DRIFT="$(HERMES_SRC="$SRC" bash "$FEATURE" apply "$SRC" 2>&1)"; DRC=$?
[ "$DRC" -ne 0 ] && ok "drift aborts apply" || bad "drift was accepted"
echo "$DRIFT" | grep -q 'UPSTREAM DRIFT' && ok "drift is named" || bad "drift message missing"
git -C "$SRCG" checkout -- apps/desktop/src/themes/presets.ts

printf '\nRESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
