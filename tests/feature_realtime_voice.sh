#!/usr/bin/env bash
# feature_realtime_voice.sh — end-to-end validation of the Realtime voice
# feature overlay (features/realtime-voice/) against a real Hermes checkout.
#
# Asserts the feature-layer guarantees:
#   1. static payload carries NO personal/secret strings (Cortana/Quentin/
#      command-center/API keys/absolute machine paths)
#   2. apply installs the feature files AND applies the tracked-file patch
#   3. verify passes on the applied tree
#   4. apply is idempotent (a second apply is a clean no-op)
#   5. config defaults are seeded, and a second seed is non-destructive
#   6. revert restores an EXACT clean upstream (0 dirty, feature files gone)
#   7. update re-apply: revert → (simulated) pull → apply lands cleanly again
#   8. drift fails LOUDLY (a moved anchor aborts apply, ships nothing partial)
#   9. (when a JS/py toolchain is present) the feature's own unit tests pass
#
# Usage:
#   ./tests/feature_realtime_voice.sh                     # clones upstream
#   HERMES_SRC=/path/to/hermes-agent ./tests/feature_realtime_voice.sh
set -uo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEATURE_DIR="$OVERLAY_DIR/features/realtime-voice"
APPLY="$FEATURE_DIR/apply-feature.sh"
UPSTREAM_URL="https://github.com/NousResearch/hermes-agent"
HERMES_REF="${HERMES_REF:-}"

PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "== 1. static payload has no personal/secret strings =="
# The public overlay must never carry the operator's LOCAL identity/config.
# (Case-insensitive; excludes this test file and the feature README's own
# prose, which legitimately explains that these must be absent.)
SCAN_HITS="$(grep -rniE 'cortana|quentin|command-center-raw|hey cortana|sk-[a-z0-9]{16}|infinitygauntlet' \
  "$FEATURE_DIR/files" "$FEATURE_DIR/patches" "$FEATURE_DIR/config" 2>/dev/null || true)"
if [ -z "$SCAN_HITS" ]; then ok "no Cortana/Quentin/command-center/API-key strings in payload"
else bad "forbidden strings in feature payload:"; printf '%s\n' "$SCAN_HITS" | sed 's/^/      /'; fi
# No machine-specific absolute paths baked into the payload.
if grep -rnE '/Users/[A-Za-z]|C:\\\\Users|/home/[a-z]+/' "$FEATURE_DIR/files" "$FEATURE_DIR/patches" >/dev/null 2>&1; then
  bad "machine-specific absolute path in payload"
else ok "no machine-specific absolute paths in payload"; fi
# Default identity must be the public product default (JARVIS, hey jarvis, marin).
RC="$FEATURE_DIR/files/apps/desktop/src/lib/voice/realtime-config.ts"
grep -q "DEFAULT_ASSISTANT_NAME = 'JARVIS'" "$RC" && ok "default assistant name is JARVIS" || bad "default assistant name not JARVIS"
grep -q "DEFAULT_WAKE_PHRASE = 'hey jarvis'" "$RC" && ok "default wake phrase is 'hey jarvis'" || bad "default wake phrase wrong"
grep -q "REALTIME_VOICE = 'marin'" "$RC" && ok "default voice is marin" || bad "default voice not marin"

# --- Acquire an upstream checkout -----------------------------------------
PY=""
for c in "${HERMES_PYTHON:-}" python3 python; do
  [ -z "$c" ] && continue
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1; then PY="$c"; break; fi
done

case "${OS:-}${OSTYPE:-}$(uname -s 2>/dev/null)" in
  *Windows_NT*|*msys*|*cygwin*|*MINGW*|*MSYS*)
    _temp_root="${LOCALAPPDATA//\\//}/Temp"
    mkdir -p "$_temp_root"
    WORK="$(mktemp -d "$_temp_root/jarvis-voice-test.XXXXXX")" ;;
  *) WORK="$(mktemp -d)" ;;
esac
HOME_DIR="$WORK/home"; mkdir -p "$HOME_DIR"
cleanup() { [ -n "${KEEP:-}" ] || rm -rf "$WORK"; }
trap cleanup EXIT

if [ -n "${HERMES_SRC:-}" ] && [ -d "$HERMES_SRC" ]; then
  # Work on a copy so the caller's checkout is never mutated.
  SRC="$WORK/hermes-agent"
  echo "▶ copying existing Hermes checkout for an isolated run…"
  git -C "$HERMES_SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git clone --quiet --local "$HERMES_SRC" "$SRC" \
    || cp -r "$HERMES_SRC" "$SRC"
  git -C "$SRC" checkout -- . 2>/dev/null || true
else
  SRC="$WORK/hermes-agent"
  echo "▶ cloning $UPSTREAM_URL (depth 1${HERMES_REF:+, ref $HERMES_REF})…"
  git clone --quiet --depth 1 ${HERMES_REF:+--branch "$HERMES_REF"} "$UPSTREAM_URL" "$SRC" \
    || { echo "FATAL: could not clone upstream"; exit 2; }
fi
# Git-for-Windows can't chdir into an MSYS "/tmp/..." path via `git -C`; use a
# mixed "C:/..." path for this harness's own git calls (no-op on Linux/macOS).
SRCG="$(cygpath -m "$SRC" 2>/dev/null || echo "$SRC")"
echo "  upstream HEAD: $(git -C "$SRCG" rev-parse --short HEAD 2>/dev/null || echo '?')"

export HERMES_SRC="$SRC" HERMES_HOME="$HOME_DIR"
[ -n "$PY" ] && export HERMES_PYTHON="$PY"

echo
echo "== 2. apply installs files + applies the tracked patch =="
# Baseline the tree state BEFORE apply so the revert check is exact and immune
# to unrelated pre-existing checkout quirks (e.g. a Windows case-fold artifact).
BASELINE="$(git -C "$SRCG" status --porcelain | sort)"
APPLY_OUT="$(bash "$APPLY" apply "$SRC" 2>&1)"; APPLY_RC=$?
echo "$APPLY_OUT" | grep -E 'copied|patch applied|seeded|feature applied' | sed 's/^/    /'
[ "$APPLY_RC" -eq 0 ] && ok "apply exited 0" || bad "apply failed (rc=$APPLY_RC)"
[ -f "$SRC/apps/desktop/src/lib/voice/voice-supervisor.ts" ] && ok "feature source file installed" || bad "feature source file missing"
[ -f "$SRC/hermes_cli/realtime_voice.py" ] && ok "backend module installed" || bad "backend module missing"
grep -q 'hermes:voice-active' "$SRC/apps/desktop/electron/main.ts" && ok "tracked patch applied (main.ts)" || bad "tracked patch not applied (main.ts)"
grep -q '/api/audio/realtime/token' "$SRC/hermes_cli/web_server.py" && ok "tracked patch applied (web_server.py)" || bad "tracked patch not applied (web_server.py)"

echo
echo "== 3. verify passes on applied tree =="
bash "$APPLY" verify "$SRC" >/dev/null 2>&1 && ok "verify passed" || bad "verify failed"

echo
echo "== 4. apply is idempotent =="
APPLY2="$(bash "$APPLY" apply "$SRC" 2>&1)"
echo "$APPLY2" | grep -q 'already applied' && ok "second apply is a no-op" || bad "second apply re-applied the patch"

echo
echo "== 5. config defaults seeded + non-destructive =="
if [ -n "$PY" ]; then
  grep -q 'realtime:' "$HOME_DIR/config.yaml" 2>/dev/null && ok "voice.realtime seeded into config.yaml" || bad "config not seeded"
  echo "$APPLY2" | grep -q 'already set by operator' && ok "second seed is non-destructive" || bad "second seed not guarded"
else
  ok "config seed skipped (no python+pyyaml) — not a failure"
fi

echo
echo "== 6. revert restores an EXACT clean upstream =="
bash "$APPLY" revert "$SRC" >/dev/null 2>&1
AFTER="$(git -C "$SRCG" status --porcelain | sort)"
if [ "$AFTER" = "$BASELINE" ]; then
  ok "tree returned to its exact pre-apply state (no feature residue)"
else
  bad "tree differs from pre-apply baseline after revert:"
  diff <(printf '%s\n' "$BASELINE") <(printf '%s\n' "$AFTER") | sed 's/^/      /' | head
fi
[ ! -e "$SRC/apps/desktop/src/lib/voice" ] && ok "feature dir removed" || bad "feature dir left behind"

echo
echo "== 7. update re-apply: revert -> pull -> apply lands cleanly =="
# Simulate the update-jarvis order: with the feature reverted (clean upstream),
# a re-apply must succeed just as it did on the first apply.
bash "$APPLY" apply "$SRC" >/dev/null 2>&1 && bash "$APPLY" verify "$SRC" >/dev/null 2>&1 \
  && ok "re-apply after revert succeeds" || bad "re-apply after revert failed"
bash "$APPLY" revert "$SRC" >/dev/null 2>&1

echo
echo "== 8. drift fails LOUDLY (ships nothing partial) =="
# Remove the anchor line the preload hunk depends on, then apply.
perl -0777 -i -pe "s/  setActiveWork: payload => ipcRenderer.send\('hermes:active-work', payload\),\n//" \
  "$SRC/apps/desktop/electron/preload.ts"
DRIFT_OUT="$(bash "$APPLY" apply "$SRC" 2>&1)"; DRIFT_RC=$?
[ "$DRIFT_RC" -ne 0 ] && ok "apply aborts on drift (rc=$DRIFT_RC)" || bad "apply did NOT fail on drift"
echo "$DRIFT_OUT" | grep -q 'UPSTREAM DRIFT' && ok "drift banner is loud + named" || bad "no drift banner"
[ ! -e "$SRC/apps/desktop/src/lib/voice" ] && ok "no orphaned feature files after drift abort" || bad "orphaned feature files left after drift"
git -C "$SRCG" checkout -- apps/desktop/electron/preload.ts 2>/dev/null || true

echo
echo "== 9. feature unit tests (when toolchain present) =="
# Backend pytest — only if the checkout has the runtime deps (fastapi/pyyaml).
if [ -n "$PY" ] && "$PY" -c 'import fastapi, starlette' >/dev/null 2>&1; then
  bash "$APPLY" apply "$SRC" >/dev/null 2>&1
  if ( cd "$SRC" && PYTHONPATH="." "$PY" -m pytest tests/hermes_cli/test_web_server_realtime_token.py -q ) >/dev/null 2>&1; then
    ok "backend realtime pytest passed"
  else
    bad "backend realtime pytest failed"
  fi
  bash "$APPLY" revert "$SRC" >/dev/null 2>&1
else
  echo "  · backend pytest skipped (fastapi/pyyaml not available here)"
fi
# The desktop vitest suite needs an installed node_modules; it runs in the
# dedicated desktop CI job, not this shell harness.
if [ -d "$SRC/apps/desktop/node_modules" ] && command -v node >/dev/null 2>&1; then
  echo "  · desktop vitest available — run it via: cd apps/desktop && npm run test:ui"
else
  echo "  · desktop vitest skipped (no node_modules; runs in the desktop CI job)"
fi

echo
echo "──────────────────────────────────────────────"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"
[ "$FAIL" -eq 0 ]
