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
# The curated verify above only re-checks the files apply.sh already brands.
# The tree-wide scan is what catches a NEW upstream file carrying the brand,
# so assert it actually ran and actually passed — not merely that apply exited.
chk "tree-wide brand scan ran"        "echo \"\$APPLY1\" | grep -q 'brand scan'"
chk "tree-wide brand scan is clean"   "echo \"\$APPLY1\" | grep -q 'no unaccounted brand strings'"

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
echo "== 4b. SOUL.md seeding: pristine defaults replaced, customized preserved =="
# Upstream's runtime seeds its default SOUL.md during install BEFORE the
# overlay stage runs. ≤ v1.1.7 the seed-if-absent guard therefore never fired
# and fresh installs kept the Hermes identity. Three contracts:
#   (a) a SOUL.md matching this tree's live DEFAULT_SOUL_MD is replaced
#   (b) the exact wording historical (≤ v1.1.7) installs left on disk is
#       replaced via the pinned hash — the live constant is branded by now,
#       so only the pin can catch it (this is the customer update path)
#   (c) anything an operator wrote is never touched
"$PY" - "$SRC/hermes_cli/default_soul.py" "$HOME_DIR/SOUL.md" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("_ds", sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
open(sys.argv[2], "w", encoding="utf-8").write(mod.DEFAULT_SOUL_MD)
PY
SOUL_A="$(bash "$OVERLAY_DIR/apply.sh" 2>&1)"
chk "live tree default replaced by persona"    "cmp -s '$HOME_DIR/SOUL.md' '$OVERLAY_DIR/persona/JARVIS.md'"
chk "replacement was reported"                 "echo \"\$SOUL_A\" | grep -q 'replaced pristine upstream default'"

# (b) the on-disk wording every ≤ v1.1.7 install carries (a test fixture —
# allowlisted in branding-known-ok.txt, never shipped to a customer surface).
cat > "$HOME_DIR/SOUL.md" <<'FIXTURE'
You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, writing and editing code, analyzing information, creative work, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations.
FIXTURE
bash "$OVERLAY_DIR/apply.sh" >/dev/null 2>&1
chk "≤v1.1.7 on-disk default replaced (pinned hash)" "cmp -s '$HOME_DIR/SOUL.md' '$OVERLAY_DIR/persona/JARVIS.md'"

# (c) operator work is sacred.
printf 'You are ATLAS, a fully customized persona the operator wrote.\n' > "$HOME_DIR/SOUL.md"
SOUL_C="$(bash "$OVERLAY_DIR/apply.sh" 2>&1)"
chk "customized SOUL left untouched"           "grep -q 'You are ATLAS' '$HOME_DIR/SOUL.md'"
chk "preservation was reported"                "echo \"\$SOUL_C\" | grep -q 'customized by operator (left as-is)'"

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
chk "dmg title -> Install JARVIS"         "grep -q '\"title\": \"Install JARVIS\"' '$D/package.json'"
chk "NS usage text -> JARVIS uses"        "grep -q 'JARVIS uses the microphone' '$D/package.json'"
# Protected functional identifiers MUST remain Hermes (updater hardcodes them;
# CFBundleName drives Electron's macOS helper-app lookup — rebranding it makes
# the app crash at launch with "Unable to find helper app").
chk "productName still Hermes (protected)"    "grep -q '\"productName\": \"Hermes\"' '$D/package.json'"
chk "executableName still Hermes (protected)" "grep -q '\"executableName\": \"Hermes\"' '$D/package.json'"
chk "CFBundleExecutable still Hermes"         "grep -q '\"CFBundleExecutable\": \"Hermes\"' '$D/package.json'"
chk "CFBundleName still Hermes (helper apps)" "grep -q '\"CFBundleName\": \"Hermes\"' '$D/package.json'"
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
echo "== 12. packaged-app helper integrity (macOS launch crash guard) =="
# Electron derives helper names from Info.plist CFBundleName; electron-builder
# names the Frameworks helpers from productName. verify-build must catch a
# drift (the "Unable to find helper app" launch crash) and pass when aligned.
FAKE="$WORK/fake-src"
FAPP="$FAKE/apps/desktop/release/mac-arm64/Hermes.app/Contents"
mkdir -p "$FAPP/Frameworks/Hermes Helper.app" "$FAPP/Frameworks/Hermes Helper (GPU).app" \
         "$FAPP/Resources/app.asar.unpacked/dist"
printf 'const W="JARVIS";' > "$FAPP/Resources/app.asar.unpacked/dist/app.js"
mk_plist() {  # <CFBundleName>
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>%s</string></dict></plist>\n' "$1" > "$FAPP/Info.plist"
}
mk_plist "Hermes"
if HERMES_SRC="$FAKE" bash "$OVERLAY_DIR/apply.sh" --verify-build "$FAKE" >/dev/null 2>&1; then
  ok "matching CFBundleName/helpers/renderer pass"
else
  bad "matching CFBundleName/helpers/renderer pass"
fi
mk_plist "JARVIS"
if HERMES_SRC="$FAKE" bash "$OVERLAY_DIR/apply.sh" --verify-build "$FAKE" >/dev/null 2>&1; then
  bad "CFBundleName/helper drift is caught"
else
  ok "CFBundleName/helper drift is caught"
fi
# A shipped bundle whose packed renderer is pristine (built from an unbranded
# tree — the 2026-07-16 regression) must be caught even when the tree is fine.
mk_plist "Hermes"
printf 'const W="HERMES AGENT";' > "$FAPP/Resources/app.asar.unpacked/dist/app.js"
if HERMES_SRC="$FAKE" bash "$OVERLAY_DIR/apply.sh" --verify-build "$FAKE" >/dev/null 2>&1; then
  bad "pristine shipped renderer is caught"
else
  ok "pristine shipped renderer is caught"
fi
rm -rf "$FAKE"

echo
echo "== 13. update-jarvis.sh self-updates its own checkout =="
# Overlay fixes are worthless if installed machines never pull them. Nothing
# used to update the checkout, so a machine could run a week-old apply.sh while
# the fix sat on main. update-jarvis.sh now pulls itself first — and must do so
# without ever being able to block, loop, or run half-old/half-new logic.
#
# Driven with HERMES_SRC pointing at nothing: self-update runs, then the script
# exits at "could not locate the Hermes source tree". That error is the marker
# that it got PAST step 0 rather than blocking there.
SU="$WORK/selfupdate"
mkdir -p "$SU" && ( cd "$SU"
  git init -q --bare origin.git
  git clone -q origin.git seed 2>/dev/null
  cp "$OVERLAY_DIR/update-jarvis.sh" seed/update-jarvis.sh
  cd seed
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm init
  git push -q origin HEAD:main
  cd ..
  # The "installed" checkout, then origin moves ahead with a marked build.
  git clone -q -b main origin.git checkout 2>/dev/null
  cd seed
  sed -i '2i echo "SELFUPDATE-NEW-VERSION-RAN"' update-jarvis.sh
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm bump
  git push -q origin HEAD:main
) >/dev/null 2>&1

SU_OUT="$(HERMES_SRC=/nonexistent-tree bash "$SU/checkout/update-jarvis.sh" 2>&1 || true)"
chk "stale checkout is pulled"        "echo \"\$SU_OUT\" | grep -q 'overlay updated'"
chk "re-execs into the new version"   "echo \"\$SU_OUT\" | grep -q 'SELFUPDATE-NEW-VERSION-RAN'"
chk "re-execs exactly once (no loop)" "[ \"\$(echo \"\$SU_OUT\" | grep -c 'SELFUPDATE-NEW-VERSION-RAN')\" -eq 1 ]"
chk "proceeds past self-update"       "echo \"\$SU_OUT\" | grep -q 'could not locate the Hermes source tree'"

# Guard: with JARVIS_SELF_UPDATED set it must not fetch, pull or re-exec — this
# is what stops a bad commit putting a machine in a fetch/exec loop.
SU_GUARD="$(JARVIS_SELF_UPDATED=1 HERMES_SRC=/nonexistent-tree bash "$SU/checkout/update-jarvis.sh" 2>&1 || true)"
chk "guard skips the self-update"     "! echo \"\$SU_GUARD\" | grep -q 'checking for overlay updates'"

# Unreachable remote: warn loudly, name the checkout, and CONTINUE. A failed
# self-update must never cost the user their Hermes update.
git clone -q -b main "$SU/origin.git" "$SU/broken" >/dev/null 2>&1
git -C "$SU/broken" remote set-url origin /nonexistent/repo.git
SU_FAIL="$(HERMES_SRC=/nonexistent-tree bash "$SU/broken/update-jarvis.sh" 2>&1 || true)"
chk "pull failure warns"              "echo \"\$SU_FAIL\" | grep -q 'could not update the JARVIS overlay checkout'"
chk "pull failure names the checkout" "echo \"\$SU_FAIL\" | grep -q \"\$SU/broken\""
chk "pull failure does NOT block"     "echo \"\$SU_FAIL\" | grep -q 'could not locate the Hermes source tree'"

# A checkout that has diverged from main cannot fast-forward; same contract.
git clone -q -b main "$SU/origin.git" "$SU/diverged" >/dev/null 2>&1
echo '# local divergence' >> "$SU/diverged/update-jarvis.sh"
git -C "$SU/diverged" -c user.email=t@t -c user.name=t commit -qam diverge >/dev/null 2>&1
SU_DIV="$(HERMES_SRC=/nonexistent-tree bash "$SU/diverged/update-jarvis.sh" 2>&1 || true)"
chk "diverged checkout does NOT block" "echo \"\$SU_DIV\" | grep -q 'could not locate the Hermes source tree'"

# Not a git checkout at all (tarball install): say so, carry on.
mkdir -p "$SU/plain" && cp "$OVERLAY_DIR/update-jarvis.sh" "$SU/plain/"
SU_PLAIN="$(HERMES_SRC=/nonexistent-tree bash "$SU/plain/update-jarvis.sh" 2>&1 || true)"
chk "non-git checkout does NOT block" "echo \"\$SU_PLAIN\" | grep -q 'could not locate the Hermes source tree'"

echo
echo "== 14. in-app updater splash is branded =="
# The updater splash is the LAST thing a user sees before the app restarts, and
# it shipped unbranded for the whole 0.20.x line: window title "Hermes",
# "Updating Hermes", "Hermes will open once done". It is served from the
# CHECKOUT (scripts/desktop-update/ui.html in an Edge window, WinForms card in
# windows.ps1) — not from downloaded pristine code — so the overlay can reach
# it. tests/brand_scan.py cannot catch this class: it searches for "Hermes
# Agent", and these strings are bare "Hermes".
UI="$SRC/scripts/desktop-update/ui.html"
PS1F="$SRC/scripts/desktop-update/windows.ps1"
if [ -f "$UI" ]; then
  chk "splash window title rebranded"   "grep -q '<title>JARVIS</title>' '$UI'"
  chk "splash heading rebranded"        "grep -q 'Updating JARVIS' '$UI'"
  chk "splash subtitle rebranded"       "grep -q 'JARVIS will open once done' '$UI'"
  chk "no bare Hermes left in splash"   "! grep -qE '\\bHermes\\b' '$UI'"
else
  ok "splash ui.html absent on this upstream (skipped)"
fi
if [ -f "$PS1F" ]; then
  chk "WinForms fallback card rebranded" "grep -q 'Updating JARVIS' '$PS1F'"
  # Hermes.exe is a PROTECTED functional filename — the real binary name the
  # updater starts. It must survive; rebranding it breaks the relaunch.
  chk "Hermes.exe filename preserved"    "grep -q 'Hermes.exe' '$PS1F'"
fi

echo
echo "== 15. in-app updater re-brands after updating =="
# The Desktop's self-update runs scripts/desktop-update/windows.ps1, which
# drives `python -m hermes_cli.main update` directly — deliberately bypassing
# the jarvis shim, so neither the shim interception nor the [command] rewrite
# can see it. Unwrapped, it reverts every branded file and repacks the Desktop
# from pristine source (observed 0.20.1 → 0.20.2: 241 files de-branded, packed
# renderer shipped "HERMES AGENT"). apply.sh injects a guarded re-brand after
# the update step so the install the updater relaunches is branded.
PS1U="$SRC/scripts/desktop-update/windows.ps1"
if [ -f "$PS1U" ]; then
  chk "updater patched with re-brand"    "grep -q 'Invoke-JarvisRebrand' '$PS1U'"
  chk "exactly one function definition"  "[ \"\$(grep -c 'function Invoke-JarvisRebrand' '$PS1U')\" -eq 1 ]"
  chk "exactly one call site"            "[ \"\$(grep -c '^    Invoke-JarvisRebrand ' '$PS1U')\" -eq 1 ]"
  # Guarded: a failed re-brand must never fail the user's update.
  chk "re-brand is wrapped in try/catch" "grep -q 'jarvis: re-brand failed' '$PS1U'"
  # Re-running apply must not inject a second copy.
  bash "$OVERLAY_DIR/apply.sh" >/dev/null 2>&1 || true
  chk "injection is idempotent"          "[ \"\$(grep -c 'function Invoke-JarvisRebrand' '$PS1U')\" -eq 1 ]"
  # If upstream reshapes the script the anchor disappears — that must be
  # reported, not silently skipped, or the in-app path goes unwrapped again.
  chk "anchor still present upstream"    "grep -qF '# -- 4. Truthful completion' '$PS1U'"
else
  ok "windows.ps1 absent on this upstream (skipped)"
fi

echo
echo "──────────────────────────────────────────────"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"
[ "$FAIL" -eq 0 ]
