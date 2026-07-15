#!/usr/bin/env bash
# overlay_smoke.sh — end-to-end validation of the JARVIS overlay against a
# real Hermes Agent checkout. Runs locally and in CI (.github/workflows).
#
# It clones upstream Hermes (or reuses $HERMES_SRC), applies the overlay to a
# throwaway HERMES_HOME, and asserts every guarantee the overlay promises:
#   1. skin YAML is valid and loads through Hermes's own skin_engine
#   2. apply.sh verify pass reports zero visible brand leaks
#   3. no standalone "Hermes" survives in ANY of the 32 locale files
#   4. apply is idempotent (2nd run rewrites 0 files)
#   5. protected identifiers are preserved (X-Hermes-Session-Token, …)
#   6. filesystem paths (~/.hermes) are preserved
#   7. command invocations are rebranded (jarvis update)
#   8. reverting branding yields a clean tree (the zero-conflict guarantee)
#   9. the banner renders in every fallback mode without error
#
# Usage:
#   ./tests/overlay_smoke.sh                 # clones upstream into a temp dir
#   HERMES_SRC=/path/to/hermes-agent ./tests/overlay_smoke.sh   # reuse a checkout
#   HERMES_REF=<branch|tag|sha> ./tests/overlay_smoke.sh        # pin upstream ref
set -uo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_URL="https://github.com/NousResearch/hermes-agent"
HERMES_REF="${HERMES_REF:-}"

# Prefer an explicitly provided interpreter (that has pyyaml); else python3/python.
PY=""
for c in "${HERMES_PYTHON:-}" python3 python; do
  [ -z "$c" ] && continue
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -z "$PY" ] && { echo "FATAL: no python3 with pyyaml found (pip install pyyaml)"; exit 2; }

PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
chk()  { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

WORK="$(mktemp -d)"
HOME_DIR="$WORK/home"; mkdir -p "$HOME_DIR"
cleanup() { [ -n "${KEEP:-}" ] || rm -rf "$WORK"; }
trap cleanup EXIT

# --- Acquire an upstream checkout -----------------------------------------
if [ -n "${HERMES_SRC:-}" ] && [ -d "$HERMES_SRC" ]; then
  SRC="$(cd "$HERMES_SRC" && pwd)"
  echo "▶ using existing Hermes checkout: $SRC"
else
  SRC="$WORK/hermes-agent"
  echo "▶ cloning $UPSTREAM_URL (depth 1${HERMES_REF:+, ref $HERMES_REF})…"
  if [ -n "$HERMES_REF" ]; then
    git clone --quiet --depth 1 --branch "$HERMES_REF" "$UPSTREAM_URL" "$SRC" \
      || git clone --quiet "$UPSTREAM_URL" "$SRC"
    [ -n "$HERMES_REF" ] && git -C "$SRC" fetch --quiet --depth 1 origin "$HERMES_REF" 2>/dev/null \
      && git -C "$SRC" checkout --quiet FETCH_HEAD 2>/dev/null || true
  else
    git clone --quiet --depth 1 "$UPSTREAM_URL" "$SRC"
  fi
fi
echo "  upstream HEAD: $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"

# Ensure a clean starting tree so idempotency/revert checks are meaningful.
git -C "$SRC" checkout -- . 2>/dev/null || true

export HERMES_SRC="$SRC" HERMES_HOME="$HOME_DIR" HERMES_PYTHON="$PY"
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8

echo
echo "== 1. skin loads through Hermes's own skin_engine =="
mkdir -p "$HOME_DIR/skins"; cp -f "$OVERLAY_DIR/skins/jarvis.yaml" "$HOME_DIR/skins/"
SKIN_OUT="$(HERMES_HOME="$HOME_DIR" PYTHONPATH="$SRC" "$PY" - <<'PY' 2>&1
import os
try:
    from hermes_cli import skin_engine as se
except Exception as e:
    print("IMPORT_FAIL", e); raise SystemExit(0)
sk = se.load_skin("jarvis")
print("agent_name=%s" % sk.get_branding("agent_name"))
print("hero=%s" % ("nonempty" if sk.banner_hero.strip() else "EMPTY"))
print("logo=%s" % ("nonempty" if sk.banner_logo.strip() else "EMPTY"))
print("label=%r" % sk.get_branding("response_label"))
PY
)"
echo "$SKIN_OUT" | sed 's/^/    /'
chk "skin agent_name is JARVIS"       "echo \"\$SKIN_OUT\" | grep -q 'agent_name=JARVIS'"
chk "banner_hero overrides caduceus"  "echo \"\$SKIN_OUT\" | grep -q 'hero=nonempty'"
chk "banner_logo present"             "echo \"\$SKIN_OUT\" | grep -q 'logo=nonempty'"

echo
echo "== 2. apply.sh runs and verify reports no leaks =="
APPLY1="$(bash "$OVERLAY_DIR/apply.sh" 2>&1)"
echo "$APPLY1" | grep -E 'rewrote|no visible|WARNING' | sed 's/^/    /'
chk "verify pass is clean"            "echo \"\$APPLY1\" | grep -q 'no visible brand strings survived'"
chk "no WARNING banner emitted"       "! echo \"\$APPLY1\" | grep -q 'WARNING'"

echo
echo "== 3. no standalone Hermes survives in the 32 locale files =="
LEAKS=$(grep -rnE '\bHermes\b' "$SRC/web/src/i18n" "$SRC/locales" 2>/dev/null \
        | grep -vE 'X-Hermes-|HermesCLI|updateHermes' | grep -cE '\.(ts|yaml):' || true)
chk "0 locale leaks (found $LEAKS)"   "[ \"$LEAKS\" -eq 0 ]"

echo
echo "== 4. idempotency: second apply rewrites 0 files =="
APPLY2="$(bash "$OVERLAY_DIR/apply.sh" 2>&1)"
chk "2nd apply rewrote 0 file(s)"     "echo \"\$APPLY2\" | grep -q 'rewrote 0 file(s)'"

echo
echo "== 5. protected identifiers preserved =="
chk "X-Hermes-Session-Token intact"   "grep -q 'X-Hermes-Session-Token' '$SRC/hermes_cli/web_server.py'"
chk "updateHermes identifier intact"  "grep -q 'updateHermes' '$SRC/web/src/App.tsx'"

echo
echo "== 6. filesystem paths preserved =="
chk "~/.hermes path left verbatim"    "grep -q '~/.hermes' '$SRC/web/src/i18n/en.ts'"

echo
echo "== 7. command invocations rebranded =="
chk "jarvis <verb> present"           "grep -qE 'jarvis (update|status|gateway|plugins)' '$SRC/locales/en.yaml' '$SRC/web/src/i18n/en.ts'"

echo
echo "== 8. revert yields a clean tree (zero-conflict guarantee) =="
git -C "$SRC" checkout -- .
DIRTY=$(git -C "$SRC" status --porcelain | wc -l | tr -d ' ')
chk "clean tree after revert ($DIRTY dirty)" "[ \"$DIRTY\" -eq 0 ]"

echo
echo "== 9. banner renders in every fallback mode =="
for mode in "" "--ascii" "--no-color" "--plain"; do
  if "$PY" "$OVERLAY_DIR/bin/jarvis-banner" $mode >/dev/null 2>&1; then
    ok "banner renders (${mode:-auto})"
  else
    bad "banner renders (${mode:-auto})"
  fi
done

echo
echo "== 10. desktop (Electron) Tier-1 source rebrand =="
# Section 8 reverted the tree; re-apply so the desktop source is branded again.
bash "$OVERLAY_DIR/apply.sh" >/dev/null 2>&1
D="$SRC/apps/desktop"
chk "wordmark rebranded to JARVIS"        "grep -q \"WORDMARK = 'JARVIS'\" '$D/src/components/chat/intro.tsx'"
chk "main.ts APP_NAME default JARVIS"     "grep -q \"|| 'JARVIS'\" '$D/electron/main.ts'"
chk "CFBundleDisplayName -> JARVIS"       "grep -q '\"CFBundleDisplayName\": \"JARVIS\"' '$D/package.json'"
chk "CFBundleName -> JARVIS"              "grep -q '\"CFBundleName\": \"JARVIS\"' '$D/package.json'"
chk "dmg title -> Install JARVIS"         "grep -q '\"title\": \"Install JARVIS\"' '$D/package.json'"
chk "NS usage text -> JARVIS uses"        "grep -q 'JARVIS uses the microphone' '$D/package.json'"
# Protected functional identifiers MUST remain Hermes (updater hardcodes them).
chk "productName still Hermes (protected)"    "grep -q '\"productName\": \"Hermes\"' '$D/package.json'"
chk "executableName still Hermes (protected)" "grep -q '\"executableName\": \"Hermes\"' '$D/package.json'"
chk "CFBundleExecutable still Hermes"         "grep -q '\"CFBundleExecutable\": \"Hermes\"' '$D/package.json'"
chk "appId still com.nousresearch.hermes"     "grep -q 'com.nousresearch.hermes' '$D/package.json'"
chk "desktop package.json still valid JSON"   "'$PY' -c 'import json,sys;json.load(open(sys.argv[1],encoding=\"utf-8\"))' '$D/package.json'"
chk "no 'Hermes Agent' in desktop i18n"       "! grep -rqE 'Hermes Agent|HERMES AGENT' '$D/src/i18n'"

echo "== 11. built-bundle verify catches leaks =="
mkdir -p "$D/dist/assets"
printf 'const W=\"JARVIS\";' > "$D/dist/assets/clean.js"
if bash "$OVERLAY_DIR/apply.sh" --verify-build "$SRC" >/dev/null 2>&1; then ok "clean built bundle passes"; else bad "clean built bundle passes"; fi
printf 'const W=\"HERMES AGENT\";' > "$D/dist/assets/leak.js"
if bash "$OVERLAY_DIR/apply.sh" --verify-build "$SRC" >/dev/null 2>&1; then bad "leaked bundle is caught"; else ok "leaked bundle is caught"; fi
rm -rf "$D/dist"

echo
echo "──────────────────────────────────────────────"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"
[ "$FAIL" -eq 0 ]
