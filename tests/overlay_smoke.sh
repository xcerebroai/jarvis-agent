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
# Verify audits installed launch points (/Applications/JARVIS.app) by default;
# the suite must judge only its own fixtures, never the host machine's app.
export JARVIS_CHECK_LAUNCH_POINTS=0

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
# apply.sh (section 2) also layered on the realtime-voice feature — which drops
# in overlay-owned UNTRACKED files a bare `git checkout -- .` cannot remove.
# Revert the feature first (scoped: only its own declared paths), then the
# branding, so the zero-conflict clean-tree guarantee still holds end to end.
FEATURE_APPLY="$OVERLAY_DIR/features/realtime-voice/apply-feature.sh"
[ -f "$FEATURE_APPLY" ] && bash "$FEATURE_APPLY" revert "$SRC" >/dev/null 2>&1 || true
APPEARANCE_APPLY="$OVERLAY_DIR/features/jarvis-appearance/apply-feature.sh"
[ -f "$APPEARANCE_APPLY" ] && bash "$APPEARANCE_APPLY" revert "$SRC" >/dev/null 2>&1 || true
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
         "$FAPP/Resources/app.asar.unpacked/dist" "$FAPP/Resources/en.lproj"
printf 'const W="JARVIS";' > "$FAPP/Resources/app.asar.unpacked/dist/app.js"
# A correctly built bundle ships the localized menu-bar name (v1.1.10) —
# without it verify_shipped_bundle rightly fails the macOS menu-bar check.
printf 'CFBundleName = "JARVIS";\n' > "$FAPP/Resources/en.lproj/InfoPlist.strings"
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
# v1.1.10: a mac bundle without the localized menu-bar name must be caught —
# that is exactly the "menu bar reads Hermes" leak shipping silently.
mk_plist "Hermes"
rm -f "$FAPP/Resources/en.lproj/InfoPlist.strings"
if HERMES_SRC="$FAKE" bash "$OVERLAY_DIR/apply.sh" --verify-build "$FAKE" >/dev/null 2>&1; then
  bad "missing menu-bar lproj is caught"
else
  ok "missing menu-bar lproj is caught"
fi
printf 'CFBundleName = "JARVIS";\n' > "$FAPP/Resources/en.lproj/InfoPlist.strings"
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
  # awk, not `sed -i '2i ...'`: BSD sed rejects that syntax, which made these
  # checks fail on every Mac while passing in CI.
  awk 'NR==2{print "echo \"SELFUPDATE-NEW-VERSION-RAN\""}1' update-jarvis.sh > u.tmp && mv u.tmp update-jarvis.sh
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm bump
  git push -q origin HEAD:main
) >/dev/null 2>&1

SU_OUT="$(HERMES_SRC=/nonexistent-tree bash "$SU/checkout/update-jarvis.sh" 2>&1 || true)"
chk "stale checkout is pulled"        "echo \"\$SU_OUT\" | grep -q 'overlay updated'"
chk "re-execs into the new version"   "echo \"\$SU_OUT\" | grep -q 'SELFUPDATE-NEW-VERSION-RAN'"
chk "re-execs exactly once (no loop)" "[ \"\$(echo \"\$SU_OUT\" | grep -c 'SELFUPDATE-NEW-VERSION-RAN')\" -eq 1 ]"
chk "proceeds past self-update"       "echo \"\$SU_OUT\" | grep -q 'could not locate the Hermes source tree'"

# Installer-provisioned machines are DETACHED at the release's pinned overlay
# commit. `git pull` cannot advance a detached HEAD, so before the fix these
# machines silently never received another overlay update (a live v1.1.7
# install still ran the old apply.sh after `jarvis update`). Simulate: detach
# the checkout at the stale commit, move origin ahead, run — the script must
# land on origin's main and re-exec into the new version.
( cd "$SU"
  git clone -q -b main origin.git detached 2>/dev/null
  git -C detached checkout -q --detach HEAD
  git -C detached branch -q -D main
  cd seed
  awk 'NR==2{print "echo \"SELFUPDATE-DETACHED-RAN\""}1' update-jarvis.sh > u.tmp && mv u.tmp update-jarvis.sh
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm detached-bump
  git push -q origin HEAD:main
) >/dev/null 2>&1
SU_DET="$(HERMES_SRC=/nonexistent-tree bash "$SU/detached/update-jarvis.sh" 2>&1 || true)"
chk "detached (installer-pinned) checkout is advanced" "echo \"\$SU_DET\" | grep -q 'overlay updated'"
chk "detached checkout re-execs into the new version"  "echo \"\$SU_DET\" | grep -q 'SELFUPDATE-DETACHED-RAN'"
chk "detached checkout lands on main"                  "[ \"\$(git -C \"$SU/detached\" symbolic-ref --short -q HEAD)\" = main ]"

# The main branch the detached path creates has NO upstream tracking, where
# `git pull --ff-only` dies with "no tracking information" — before the
# tracking-independent fix, that stranded every machine one update after its
# first successful one (found live). Simulate: main with tracking stripped,
# origin moves ahead — the script must still advance.
( cd "$SU"
  git clone -q -b main origin.git untracked 2>/dev/null
  git -C untracked config --unset branch.main.remote
  git -C untracked config --unset branch.main.merge
  cd seed
  awk 'NR==2{print "echo \"SELFUPDATE-UNTRACKED-RAN\""}1' update-jarvis.sh > u.tmp && mv u.tmp update-jarvis.sh
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm untracked-bump
  git push -q origin HEAD:main
) >/dev/null 2>&1
SU_UNT="$(HERMES_SRC=/nonexistent-tree bash "$SU/untracked/update-jarvis.sh" 2>&1 || true)"
chk "untracked main is advanced (no tracking info)"    "echo \"\$SU_UNT\" | grep -q 'overlay updated'"
chk "untracked main re-execs into the new version"     "echo \"\$SU_UNT\" | grep -q 'SELFUPDATE-UNTRACKED-RAN'"

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
  # The glyph, not just the text: upstream's Fourier-curve loader is its brand
  # mark. apply.sh swaps the svg mount for the JARVIS mark (data-URI + pulse).
  chk "splash glyph is the JARVIS mark"  "grep -q 'jarvis-splash-mark' '$UI'"
  chk "upstream loader glyph unmounted"  "! grep -q 'appendChild(svg)' '$UI'"
  # macOS menu-bar name: localized CFBundleName override must be staged and
  # shipped via extraResources (raw CFBundleName stays Hermes for helpers).
  chk "menu-bar InfoPlist.strings staged" "grep -q 'CFBundleName = \"JARVIS\"' '$SRC/apps/desktop/build/en.lproj/InfoPlist.strings'"
  chk "extraResources ships en.lproj"     "grep -q '\"to\": \"en.lproj\"' '$SRC/apps/desktop/package.json'"
  chk "camera permission text rebranded"  "! grep -q '\"Hermes uses the camera' '$SRC/apps/desktop/package.json'"
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
echo "== 15b. macOS in-app updater (posix.sh) re-brands after updating =="
# The SAME hole as section 15 on the other OS: posix.sh runs
# "$INSTALL_ROOT/venv/bin/hermes" update directly. Observed live 2026-08-19:
# a divergence reset (0.20.3 → 0.20.4) left the tree pristine, the renderer
# was repacked from it, and /Applications got an unbranded bundle — HERMES
# AGENT home view on glass while no verify ever audited the launch point.
PSXU="$SRC/scripts/desktop-update/posix.sh"
if [ -f "$PSXU" ]; then
  chk "posix updater patched with re-brand"  "grep -q 'jarvis_rebrand' '$PSXU'"
  chk "exactly one function definition"      "[ \"\$(grep -c '^jarvis_rebrand()' '$PSXU')\" -eq 1 ]"
  chk "exactly one call site"                "[ \"\$(grep -c '^jarvis_rebrand || true' '$PSXU')\" -eq 1 ]"
  chk "re-brand failure cannot fail update"  "grep -q 'update itself is unaffected' '$PSXU'"
  chk "rebuilds bundle from branded source"  "grep -q 'desktop --force-build --build-only' '$PSXU'"
  chk "patched posix.sh still parses"        "bash -n '$PSXU'"
  bash "$OVERLAY_DIR/apply.sh" >/dev/null 2>&1 || true
  chk "posix injection is idempotent"        "[ \"\$(grep -c '^jarvis_rebrand()' '$PSXU')\" -eq 1 ]"
  chk "posix anchor still present upstream"  "grep -qF '# Truthful completion:' '$PSXU'"
else
  ok "posix.sh absent on this upstream (skipped)"
fi

echo
echo "== 15c. JARVIS HUD plugin installs and stands alone =="
# Runtime plugin: data-home artifact, no tree patch. Contract checks: apply
# installs it; only allowlisted imports (SDK + react — the loader rejects
# anything else); wake wiring present; and the synthesized-pulse fallback
# exists so a keyless, hook-less install still animates.
HUD="$HOME_DIR/desktop-plugins/jarvis-hud/plugin.js"
if [ -f "$OVERLAY_DIR/plugins/jarvis-hud/plugin.js" ]; then
  chk "plugin installed into the data home"   "[ -f '$HUD' ]"
  chk "imports limited to SDK + react"        "! grep -E \"from '\" '$HUD' | grep -vE \"from '(@hermes/plugin-sdk|react|react/jsx-runtime)'\" | grep -q ."
  chk "route + sidebar + palette registered"  "grep -q 'ROUTES_AREA' '$HUD' && grep -q 'SIDEBAR_NAV_AREA' '$HUD' && grep -q 'PALETTE_AREA' '$HUD'"
  chk "wake surfaces the orb"                 "grep -q \"onEvent('wake.detected'\" '$HUD'"
  chk "real amplitude feed consumed"          "grep -q \"onEvent('voice.amplitude'\" '$HUD'"
  chk "synthesized fallback present"          "grep -q 'createAmplitudeSource' '$HUD' && grep -q 'kick' '$HUD'"
  chk "orb click / Esc hard-kill wired"       "grep -q 'jarvis:voice-kill' '$HUD' && grep -q \"key === 'Escape'\" '$HUD'"
  if command -v node >/dev/null 2>&1; then
    chk "plugin.js parses as ESM"             "node --input-type=module --check < '$HUD'"
  fi
else
  bad "plugins/jarvis-hud/plugin.js missing from overlay"
fi

echo
echo "== 16. 'jarvis update' targets the ACTIVE install, not a stale sibling =="
# The shims used to hardcode HERMES_SRC to the overlay checkout's SIBLING.
# On a customer install that is correct — the overlay sits at
# %LOCALAPPDATA%\hermes\jarvis-agent and its sibling IS the active tree.
# On a dev layout (overlay checked out elsewhere, beside an old scratch clone)
# the sibling is NOT the tree `hermes update` updates, so every update ran
# against a stale tree while the real install went untouched — which is how a
# month-old checkout produced feature-patch drift banners for patches that
# applied cleanly to current upstream.
#
# Contract: prefer $HERMES_HOME/hermes-agent; fall back to the sibling; never
# override an explicit HERMES_SRC. The customer case must be a NO-OP.
RES="$WORK/resolve"; rm -rf "$RES"; mkdir -p "$RES"
_mkovl() { mkdir -p "$1"; printf '#!/usr/bin/env bash
echo "SRC=${HERMES_SRC:-<unset>}"
' > "$1/update-jarvis.sh"; }
_resolve() {  # <HERMES_HOME> <overlay> [explicit HERMES_SRC]
  # HOME/LOCALAPPDATA are redirected into the sandbox as well: if the stub
  # overlay were ever missed, the shim's fallback candidates must NOT be able
  # to resolve to a REAL overlay on the machine and run a real update.
  HERMES_HOME="$1" JARVIS_OVERLAY_DIR="$2" HERMES_SRC="${3:-}"   HOME="$RES/nohome" LOCALAPPDATA="$RES/nolocal"     bash "$OVERLAY_DIR/bin/jarvis" update 2>/dev/null | sed -n 's/^SRC=//p'
}

# (a) customer layout: overlay sibling IS the active tree -> identical, no-op.
mkdir -p "$RES/cust/hermes/hermes-agent"; _mkovl "$RES/cust/hermes/jarvis-agent"
CUST="$(_resolve "$RES/cust/hermes" "$RES/cust/hermes/jarvis-agent")"
chk "customer layout resolves to the active tree" "[ \"$CUST\" = \"$RES/cust/hermes/hermes-agent\" ]"
chk "customer layout: sibling == active (no-op)"  "[ \"$CUST\" = \"$(dirname "$RES/cust/hermes/jarvis-agent")/hermes-agent\" ]"

# (b) dev layout: sibling is a DIFFERENT (stale) tree -> must pick the active one.
mkdir -p "$RES/dev/home/hermes/hermes-agent" "$RES/dev/jarvis/hermes-agent"
_mkovl "$RES/dev/jarvis/jarvis-agent"
DEV="$(_resolve "$RES/dev/home/hermes" "$RES/dev/jarvis/jarvis-agent")"
chk "dev layout resolves to the ACTIVE install"   "[ \"$DEV\" = \"$RES/dev/home/hermes/hermes-agent\" ]"
chk "dev layout does NOT pick the stale sibling"  "[ \"$DEV\" != \"$RES/dev/jarvis/hermes-agent\" ]"

# (c) an explicit HERMES_SRC always wins.
OVR="$(_resolve "$RES/dev/home/hermes" "$RES/dev/jarvis/jarvis-agent" "/explicit/override")"
chk "explicit HERMES_SRC is never overridden"     "[ \"$OVR\" = \"/explicit/override\" ]"

# (d) no active tree at all -> the historical sibling behaviour still applies.
mkdir -p "$RES/fb/home/hermes" "$RES/fb/jarvis/hermes-agent"; _mkovl "$RES/fb/jarvis/jarvis-agent"
FB="$(_resolve "$RES/fb/home/hermes" "$RES/fb/jarvis/jarvis-agent")"
chk "sibling fallback preserved when no active"   "[ \"$FB\" = \"$RES/fb/jarvis/hermes-agent\" ]"

# The .cmd shim must implement the same order (it is the Windows entry point).
chk "jarvis.cmd prefers HERMES_HOME too"          "grep -q 'JHOME' '$OVERLAY_DIR/bin/jarvis.cmd'"
chk "jarvis.cmd keeps the sibling fallback"       "grep -q 'hermes-agent' '$OVERLAY_DIR/bin/jarvis.cmd'"

echo
echo "──────────────────────────────────────────────"
echo "  RESULT: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"
[ "$FAIL" -eq 0 ]
