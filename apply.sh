#!/usr/bin/env bash
# apply.sh — apply the JARVIS white-label overlay to a Hermes Agent install.
#
# Idempotent. Runs after install and after every `hermes update`. Rewrites
# ONLY customer-visible strings and installs the JARVIS skin/persona/assets.
# Running it twice is a no-op (every rewrite produces "JARVIS"/"jarvis", which
# contains no "Hermes"/"hermes <verb>", so a second pass matches nothing).
#
# The interactive CLI is rebranded via Hermes's native skin engine (a data
# file in ~/.hermes/skins/, outside the repo) — the biggest, most-churned
# brand surface therefore NEVER causes a merge conflict on update.
#
# Source-string rewrites cover the dashboard, chat catalogs, and the few
# hardcoded brand strings the skin cannot reach. A repo-wide audit confirmed
# NO capitalized "Hermes" is used as a functional value and NO
# `subprocess("hermes <verb>")` exec strings exist, so the rewrite rules can
# only alter prose/labels/instructions — never program behavior. Protected
# identifiers (X-Hermes-Session-Token, updateHermes, HERMES_HOME, …) are
# masked regardless. Filesystem paths (~/.hermes) and everything under
# website/ are never touched.
#
# Usage:  ./apply.sh [HERMES_SRC]
# Source-tree resolution:  $HERMES_SRC  ->  $1  ->  autodetect via hermes_cli.
# User-data dir defaults to ~/.hermes (override with $HERMES_HOME).
# -E so the ERR trap below is inherited by functions, subshells and command
# substitutions — without it, a failure inside a function dies untrapped.
set -Eeuo pipefail

# Never die silently. `set -e` aborts with no output whatsoever when the failing
# command printed nothing — e.g. a bare `[ -f "$f" ]` test. That produced a
# report of apply.sh "stopping mid-run with no error", which is unfalsifiable
# from the outside and indistinguishable from a hang. Any non-zero now names
# the line, the command, and warns that the tree is half-rewritten.
_apply_failed() {
  local rc=$?
  echo "" >&2
  echo "  ##################################################################" >&2
  echo "  # apply.sh FAILED — exit $rc" >&2
  echo "  #   line:    ${BASH_LINENO[0]:-?}" >&2
  echo "  #   command: ${BASH_COMMAND}" >&2
  echo "  #" >&2
  echo "  # The source tree is very likely PARTIALLY BRANDED: some files were" >&2
  echo "  # rewritten and some were not. Fix the cause and re-run apply.sh —" >&2
  echo "  # it is idempotent, so a clean re-run repairs the tree." >&2
  echo "  ##################################################################" >&2
  exit "$rc"
}
trap _apply_failed ERR

# Ensure any child Python/Perl emits UTF-8 even on a legacy Windows console
# (cp1252), so ◆/✓/box-art output never raises UnicodeEncodeError.
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP="$OVERLAY_DIR/branding.map"

# Mode: `apply.sh --verify-build [SRC]` verifies the BUILT desktop renderer
# bundle only (called by install/update AFTER the Electron rebuild). Default
# mode installs the skin and rewrites source strings.
MODE="apply"
if [ "${1:-}" = "--verify-build" ]; then MODE="verify-build"; shift; fi

# Exclude list — repo-relative paths the overlay must NEVER brand or revert.
# Sources: $OVERLAY_DIR/branding.exclude (one path per line, # comments) and
# the JARVIS_EXCLUDE env var (whitespace-separated). Operators list files they
# maintain their own local patches to, so the overlay leaves them fully alone.
EXCLUDES=()
if [ -f "$OVERLAY_DIR/branding.exclude" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && EXCLUDES+=("$line")
  done < "$OVERLAY_DIR/branding.exclude"
fi
if [ -n "${JARVIS_EXCLUDE:-}" ]; then
  for line in $JARVIS_EXCLUDE; do [ -n "$line" ] && EXCLUDES+=("$line"); done
fi
is_excluded() {
  local rel="$1" e
  for e in "${EXCLUDES[@]:-}"; do [ -n "$e" ] && [ "$rel" = "$e" ] && return 0; done
  return 1
}

resolve_python() {
  # (#10) Prefer the install's venv python: pyyaml==6.0.3 is a CORE Hermes
  # dep, guaranteed there; system pythons on end-user machines (winget/uv
  # installs) usually lack it, which used to silently skip skin activation
  # and the package.json JSON guard. $SRC may be unset when called from
  # resolve_src pre-resolution — those candidates simply don't exist then.
  # 'py'/'python3' before bare 'python' to avoid the Windows Store alias noise.
  for c in "${HERMES_PYTHON:-}" \
           "${SRC:-/nonexistent}/venv/bin/python" "${SRC:-/nonexistent}/venv/Scripts/python.exe" \
           python3 py python; do
    [ -z "$c" ] && continue
    if { [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; } && "$c" -c 'import yaml' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

resolve_src() {
  if [ -n "${HERMES_SRC:-}" ]; then echo "$HERMES_SRC"; return 0; fi
  if [ -n "${1:-}" ]; then echo "$1"; return 0; fi
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

# Resolve the runtime's Hermes home the SAME way hermes_constants.get_hermes_home()
# does — the single source of truth the CLI actually reads the skin/config from:
#   $HERMES_HOME override  ->  Windows: %LOCALAPPDATA%\hermes  ->  else ~/.hermes
# This matters because the two install paths use DIFFERENT homes on Windows:
#   • script installers (setup-hermes.sh) historically assumed ~/.hermes, but
#   • the Setup binary / scripts/install.ps1 install into %LOCALAPPDATA%\hermes.
# Writing the skin to the wrong home means CLI branding silently doesn't apply.
# We ask the installed hermes_constants first (tracks upstream if the rule ever
# changes), then fall back to replicating the platform rule in pure bash.
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

# macOS launch-integrity check: Electron's main delegate derives the helper
# apps it loads from the bundle's Info.plist CFBundleName
# ("<CFBundleName> Helper*.app", electron_main_delegate_mac.mm), while
# electron-builder names the helpers in Contents/Frameworks from productName.
# If they drift apart the app crashes at launch with "Unable to find helper
# app". For every packaged .app: every helper name the Info.plist implies
# must exist in Contents/Frameworks.
read_bundle_name() {  # <Info.plist> — prints CFBundleName or nothing
  local plist="$1" py
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$plist" 2>/dev/null && return 0
  fi
  py="$(resolve_python || true)"
  [ -n "$py" ] && "$py" -c 'import plistlib,sys;print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleName"])' "$plist" 2>/dev/null
}
verify_macos_helpers() {
  local src="$1" rc=0 checked=0 app plist fw bname h suffix want
  for app in "$src/apps/desktop/release"/mac*/*.app; do
    [ -d "$app" ] || continue
    plist="$app/Contents/Info.plist"; fw="$app/Contents/Frameworks"
    [ -f "$plist" ] && [ -d "$fw" ] || continue
    bname="$(read_bundle_name "$plist")"
    if [ -z "$bname" ]; then
      echo "  ⚠ could not read CFBundleName from ${app##*/} — cannot verify helper apps"
      rc=1; continue
    fi
    checked=$((checked + 1))
    local helpers=0
    for h in "$fw"/*\ Helper*.app; do
      [ -d "$h" ] || continue
      helpers=$((helpers + 1))
      # "<anything> Helper<suffix>.app" must exist as "<bname> Helper<suffix>.app"
      suffix="${h##*/}"; suffix="${suffix#* Helper}"; suffix="${suffix%.app}"
      want="$fw/$bname Helper$suffix.app"
      if [ ! -d "$want" ]; then
        echo "  ⚠ ${app##*/}: Info.plist implies helper \"$bname Helper$suffix.app\" but Frameworks has \"${h##*/}\""
        echo "    → the app will crash at launch (\"Unable to find helper app\")."
        echo "    CFBundleName must stay \"Hermes\" — see branding.map [desktop] notes."
        rc=1
      fi
    done
    if [ "$helpers" -eq 0 ]; then
      echo "  ⚠ ${app##*/}: no helper apps in Contents/Frameworks at all — broken Electron bundle"
      rc=1
    fi
  done
  [ "$checked" -gt 0 ] && [ "$rc" -eq 0 ] && \
    echo "  ✓ helper apps match CFBundleName in $checked packaged macOS bundle(s) — launch-safe"
  return "$rc"
}

# Verify ONE packaged/installed bundle — the artifact that actually ships.
# 2026-07-16 lesson: the tree's apps/desktop/dist can be branded while the
# packaged app carries a pristine renderer built from another tree, so
# checking the tree alone "passes" against the wrong artifact. Check the
# bundle's own renderer payload (app.asar.unpacked/dist, falling back to a
# raw scan of app.asar) and its packed icon.
verify_shipped_bundle() {  # <.app bundle or *-unpacked dir>
  local app="$1" rc=0 res="" cand unpacked name
  name="${app##*/}"
  for cand in "$app/Contents/Resources" "$app/resources"; do
    [ -d "$cand" ] && { res="$cand"; break; }
  done
  [ -n "$res" ] || return 0   # not a packaged bundle layout we know — skip
  unpacked="$res/app.asar.unpacked/dist"
  if [ -d "$unpacked" ]; then
    if grep -rqE 'Hermes Agent|HERMES AGENT' "$unpacked" 2>/dev/null; then
      echo "  ⚠ $name ships a PRISTINE renderer (found 'HERMES AGENT' in app.asar.unpacked/dist)"
      rc=1
    elif ! grep -rq 'JARVIS' "$unpacked" 2>/dev/null; then
      echo "  ⚠ $name renderer has no JARVIS wordmark — rebrand did not reach the shipped bundle"
      rc=1
    fi
  elif [ -f "$res/app.asar" ]; then
    if grep -aqE 'Hermes Agent|HERMES AGENT' "$res/app.asar" 2>/dev/null; then
      echo "  ⚠ $name ships a PRISTINE renderer (found 'HERMES AGENT' in app.asar)"
      rc=1
    elif ! grep -aq 'JARVIS' "$res/app.asar" 2>/dev/null; then
      echo "  ⚠ $name app.asar has no JARVIS wordmark — rebrand did not reach the shipped bundle"
      rc=1
    fi
  fi
  # Packed icon must be the JARVIS art (byte-identical to the overlay's copy —
  # electron-builder copies the .icns verbatim from build.icon).
  if [ -f "$res/icon.icns" ] && [ -f "$OVERLAY_DIR/installer/assets/icons/icon.icns" ]; then
    if ! cmp -s "$res/icon.icns" "$OVERLAY_DIR/installer/assets/icons/icon.icns"; then
      echo "  ⚠ $name packs upstream icon art (Resources/icon.icns ≠ JARVIS icon.icns)"
      rc=1
    fi
  fi
  # macOS menu-bar name: the app menu title comes from the LOCALIZED
  # CFBundleName (en.lproj/InfoPlist.strings), which extraResources ships into
  # Contents/Resources. The raw Info.plist CFBundleName must stay "Hermes"
  # (helper lookup), so WITHOUT this file the menu bar reads "Hermes" beside a
  # fully branded window — the macOS analog of the window-title leak.
  if [ "$res" = "$app/Contents/Resources" ]; then
    if [ -f "$res/en.lproj/InfoPlist.strings" ]; then
      grep -q 'CFBundleName = "JARVIS"' "$res/en.lproj/InfoPlist.strings" 2>/dev/null || {
        echo "  ⚠ $name ships en.lproj/InfoPlist.strings without CFBundleName=JARVIS — menu bar reads Hermes"
        rc=1
      }
    else
      echo "  ⚠ $name has no en.lproj/InfoPlist.strings — macOS menu bar reads Hermes"
      rc=1
    fi
  fi
  # Runtime dock/window icon: electron/main.ts APP_ICON_PATHS feeds the packed
  # dist/apple-touch-icon.png to app.dock.setIcon() — the bundle's icon.icns
  # being JARVIS does NOT cover this; a pristine copy here means the RUNNING
  # app docks upstream art. Byte-compare against the overlay PNG apply used.
  local touch_ref="" _p
  for _p in "$OVERLAY_DIR/installer/assets/icons/icon-512.png" \
            "$OVERLAY_DIR/installer/assets/icons/128x128@2x.png"; do
    [ -f "$_p" ] && { touch_ref="$_p"; break; }
  done
  if [ -n "$touch_ref" ] && [ -f "$unpacked/apple-touch-icon.png" ]; then
    if ! cmp -s "$unpacked/apple-touch-icon.png" "$touch_ref"; then
      echo "  ✗ $name packs upstream RUNTIME icon (unpacked dist/apple-touch-icon.png ≠ JARVIS art) — dock shows upstream while running"
      rc=1
    fi
  fi
  # The window title. This is what the OS shows as the window caption AND as
  # the taskbar button's label, so a pristine one reads "Hermes" right next to
  # the JARVIS icon. It comes from apps/desktop/index.html, which the overlay
  # did not brand (it branded web/index.html — the dashboard's, a different
  # file), so the packed renderer shipped <title>Hermes</title>.
  if [ -f "$unpacked/index.html" ]; then
    if grep -q '<title>[^<]*Hermes' "$unpacked/index.html" 2>/dev/null; then
      echo "  ✗ $name packs an unbranded window TITLE (dist/index.html <title> still says Hermes) — taskbar label reads Hermes"
      rc=1
    fi
  fi
  # Windows taskbar icon. electron/main.ts builds APP_ICON_PATHS with
  # `process.resourcesPath/icon.ico` FIRST on Windows (shipped via
  # extraResources) and only falls back to the padded PNG when it is absent —
  # so on Windows this file, not apple-touch-icon.png, is what the running app
  # shows in the taskbar and alt-tab. It was never checked here, which is how a
  # bundle shipped upstream art at runtime while the PNG check passed.
  if [ -f "$res/icon.ico" ] && [ -f "$OVERLAY_DIR/installer/assets/icons/icon.ico" ]; then
    if ! cmp -s "$res/icon.ico" "$OVERLAY_DIR/installer/assets/icons/icon.ico"; then
      echo "  ✗ $name packs upstream TASKBAR icon (resources/icon.ico ≠ JARVIS art) — taskbar shows upstream while running"
      rc=1
    fi
  fi
  [ "$rc" -eq 0 ] && echo "  ✓ shipped bundle OK: $app"
  return "$rc"
}

# Verify the BUILT desktop output. Covers the renderer bundle
# (apps/desktop/dist), macOS helper-app launch integrity, and — crucially —
# the packaged bundles that ship (release/) plus, when
# JARVIS_CHECK_LAUNCH_POINTS=1 (set by update-jarvis.sh), the installed
# launch-point copies in /Applications. Called after an Electron rebuild.
verify_desktop_build() {
  local src="$1"
  local dist="$src/apps/desktop/dist"
  local phrase_hits rc=0 b
  echo "◆ JARVIS desktop — verify built renderer bundle"
  if [ ! -d "$dist" ]; then
    echo "  · no built bundle at apps/desktop/dist — desktop not built here"
  else
    # Distinctive visible brand phrases must NOT survive in the bundled output.
    phrase_hits="$(grep -rloE 'Hermes Agent|HERMES AGENT' "$dist" 2>/dev/null | head -5 || true)"
    if [ -n "$phrase_hits" ]; then
      echo "  ⚠ visible brand phrase(s) found in built bundle:"
      printf '%s\n' "$phrase_hits" | sed "s|^|      |; s|$dist|apps/desktop/dist|"
      rc=1
    fi
    # The JARVIS wordmark must be present — proof the rebrand reached the build.
    if grep -rqE 'JARVIS' "$dist" 2>/dev/null; then
      echo "  ✓ JARVIS wordmark present in built bundle"
    else
      echo "  ⚠ JARVIS wordmark NOT found in built bundle — rebrand did not reach the build"
      rc=1
    fi
  fi
  # Packaged-app launch integrity (macOS helper-name derivation).
  verify_macos_helpers "$src" || rc=1
  # The bundles that actually ship: packaged release output + launch points.
  for b in "$src/apps/desktop/release"/mac*/*.app \
           "$src/apps/desktop/release"/*-unpacked; do
    [ -d "$b" ] || continue
    verify_shipped_bundle "$b" || rc=1
  done
  # Launch points are audited whenever they EXIST — not only when
  # update-jarvis.sh opts in. The artifact the customer actually runs is
  # /Applications/JARVIS.app, and the 2026-08-19 regression proved a verify
  # that skips it can report green while the screen says HERMES AGENT: the
  # in-app updater swapped a pristine bundle into /Applications and no code
  # path ever audited it. JARVIS_CHECK_LAUNCH_POINTS=0 opts out (fixtures).
  if [ "${JARVIS_CHECK_LAUNCH_POINTS:-1}" != "0" ]; then
    for b in "/Applications/JARVIS.app" "$HOME/Applications/JARVIS.app"; do
      [ -d "$b" ] || continue
      verify_shipped_bundle "$b" || rc=1
    done
  fi
  if [ "$rc" -eq 0 ]; then
    echo "  ✓ desktop build + shipped bundles carry JARVIS branding (no brand leaks)"
  else
    echo
    echo "  ##################################################################"
    echo "  # WARNING: the desktop build or a shipped bundle is un-rebranded! #"
    echo "  # Re-run apply.sh then rebuild:  <jarvis|hermes> desktop --build-only #"
    echo "  ##################################################################"
  fi
  return "$rc"
}

SRC="$(resolve_src "${1:-}" || true)"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR: could not locate the Hermes source tree." >&2
  echo "       Pass it explicitly:  HERMES_SRC=/path/to/hermes-agent ./apply.sh" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"

# --verify-build: check the built bundle and exit (no skin/source changes).
if [ "$MODE" = "verify-build" ]; then
  # A failed verification is a RESULT, not a crash. Disarm the ERR trap first:
  # otherwise the non-zero return trips it and prints "apply.sh FAILED … the
  # tree is PARTIALLY BRANDED", which is both untrue here (verify changes
  # nothing) and drowns out the ✗ lines that say what is actually wrong.
  trap - ERR
  set +e
  verify_desktop_build "$SRC"
  vb_rc=$?
  if [ "$vb_rc" -ne 0 ]; then
    echo "  ✗ bundle verification FAILED (exit $vb_rc) — see the ✗ line(s) above" >&2
  fi
  exit "$vb_rc"
fi

HERMES_HOME="$(resolve_hermes_home "$SRC")"

# The desktop app's ACTIVE source tree. Electron's main process pins
# ACTIVE_HERMES_ROOT = $HERMES_HOME/hermes-agent and its in-app updater
# rebuilds from THAT tree (`hermes desktop --build-only`), then dittos the
# result over the installed .app and relaunches. If that tree isn't branded,
# any self-update silently ships a pristine HERMES desktop over the branded
# one — so when it differs from $SRC, apply.sh cascades onto it (section 5).
ACTIVE_ROOT=""
if [ -d "$HERMES_HOME/hermes-agent/.git" ]; then
  ACTIVE_ROOT="$(cd "$HERMES_HOME/hermes-agent" && pwd)"
fi

# Per-tree manifest name. The ACTIVE root must keep the legacy
# "branded-files.txt" — the installer's injected pre-update revert
# (inject-overlay-stage.sh) hardcodes that name against the active root.
# Any OTHER tree gets a path-keyed manifest so branding two trees never
# clobbers each other's revert list.
manifest_name() {  # <src-abs-path>
  if [ -n "$ACTIVE_ROOT" ] && [ "$1" != "$ACTIVE_ROOT" ]; then
    printf 'branded-files@%s.txt' "$(printf '%s' "$1" | cksum | awk '{print $1}')"
  else
    printf 'branded-files.txt'
  fi
}

echo "◆ JARVIS overlay — applying"
echo "  source : $SRC"
echo "  data   : $HERMES_HOME"
[ -n "$ACTIVE_ROOT" ] && [ "$ACTIVE_ROOT" != "$SRC" ] && \
  echo "  active : $ACTIVE_ROOT (desktop app's self-rebuild tree — branded in section 5)"

# (#13) The skin/config in $HERMES_HOME are PER-USER and shared by every
# Hermes install on this machine — activating the JARVIS skin rebrands the
# CLI of all of them (the runtime reads exactly one home). Warn loudly when
# another hermes-agent tree exists so this is never a surprise.
for _other in "${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/hermes-agent" \
              "$HOME/.hermes/hermes-agent" "$HOME/jarvis/hermes-agent"; do
  [ -d "$_other/.git" ] || continue
  [ "$(cd "$_other" 2>/dev/null && pwd)" = "$SRC" ] && continue
  # The active root is handled by the section-5 cascade, not a warning.
  [ -n "$ACTIVE_ROOT" ] && [ "$(cd "$_other" 2>/dev/null && pwd)" = "$ACTIVE_ROOT" ] && continue
  echo "  ⚠ another Hermes install exists at: $_other"
  echo "    The CLI skin/config in $HERMES_HOME are shared per-user, so that"
  echo "    install's CLI will show JARVIS branding too. To undo later: remove"
  echo "    display.skin from config.yaml and delete skins/jarvis.yaml there."
done
[ -f "$MAP" ] || { echo "ERROR: branding.map not found at $MAP" >&2; exit 1; }

# --- 1. Install the CLI skin (data, no source edit) -----------------------
mkdir -p "$HERMES_HOME/skins"
cp -f "$OVERLAY_DIR/skins/jarvis.yaml" "$HERMES_HOME/skins/jarvis.yaml"
echo "  ✓ skin    -> $HERMES_HOME/skins/jarvis.yaml"

# Seed the JARVIS persona as SOUL.md. Absent -> seed. Present -> replace ONLY
# when provably pristine: upstream's runtime writes its default SOUL.md during
# install BEFORE this overlay stage runs (≤ v1.1.7 shipped that race, so fresh
# installs introduced themselves as Hermes), which means "already present" does
# not imply "the operator wrote it". Pristine = normalized content matches a
# known upstream default: a pinned hash of the wording historical installers
# left behind, or the live DEFAULT_SOUL_MD / legacy templates in this tree's
# hermes_cli/default_soul.py. Anything else is operator work — never touched.
# No python -> can't prove pristine -> preserve (the safe failure).
if [ -f "$OVERLAY_DIR/persona/JARVIS.md" ]; then
  SOUL_PY="$(resolve_python || true)"
  SOUL_SEED=""
  if [ ! -f "$HERMES_HOME/SOUL.md" ]; then
    SOUL_SEED="seeded"
  elif [ -n "$SOUL_PY" ] && SOUL_PATH="$HERMES_HOME/SOUL.md" \
       DEFAULT_SOUL_SRC="$SRC/hermes_cli/default_soul.py" "$SOUL_PY" - <<'PY'
import hashlib, importlib.util, os, sys

def norm(s):
    return "\n".join(l.rstrip() for l in s.replace("\r\n", "\n").strip().split("\n"))

try:
    soul = open(os.environ["SOUL_PATH"], encoding="utf-8", errors="replace").read()
except OSError:
    sys.exit(1)

# Normalized sha256 of the default every installer ≤ v1.1.7 left behind
# (upstream runtime wording as of hermes-agent 51de5c9). Pinned so the
# v1.1.7 -> v1.1.8 update path replaces it even though the live tree's
# constant has been branded to JARVIS by then and no longer matches.
PINNED = {
    "2765a846e1bb371d78d3b93b403dfb0f8d1ba1a9895edb5f608367abfe81194d",
}
if hashlib.sha256(norm(soul).encode("utf-8")).hexdigest() in PINNED:
    sys.exit(0)

# The live default + legacy scaffolds from this tree — covers upstream
# rewording the default faster than we re-pin. Loaded straight from the file
# to avoid importing the hermes_cli package (heavy, side-effectful).
try:
    spec = importlib.util.spec_from_file_location("_ds", os.environ["DEFAULT_SOUL_SRC"])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
except Exception:
    sys.exit(1)
if norm(soul) == norm(mod.DEFAULT_SOUL_MD) or mod.is_legacy_template_soul(soul):
    sys.exit(0)
sys.exit(1)
PY
  then
    SOUL_SEED="replaced pristine upstream default"
  fi
  if [ -n "$SOUL_SEED" ]; then
    cp -f "$OVERLAY_DIR/persona/JARVIS.md" "$HERMES_HOME/SOUL.md"
    echo "  ✓ persona -> $HERMES_HOME/SOUL.md ($SOUL_SEED)"
  else
    echo "  · persona -> $HERMES_HOME/SOUL.md customized by operator (left as-is)"
  fi
fi

# Activate the skin in config.yaml (idempotent; preserves the rest of config).
PY="$(resolve_python || true)"
if [ -n "$PY" ]; then
  HERMES_HOME="$HERMES_HOME" "$PY" - <<'PY'
import os, io
try:
    import yaml
except Exception:
    raise SystemExit(0)
home = os.environ["HERMES_HOME"]
path = os.path.join(home, "config.yaml")
data = {}
if os.path.isfile(path):
    with io.open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
if not isinstance(data, dict):
    data = {}
disp = data.get("display")
if not isinstance(disp, dict):
    disp = {}
if disp.get("skin") != "jarvis":
    disp["skin"] = "jarvis"
    data["display"] = disp
    with io.open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)
    print("  ✓ config  -> display.skin = jarvis")
else:
    print("  ✓ config  -> display.skin already jarvis")
PY
else
  echo "  ! no python+pyyaml found; set 'display.skin: jarvis' in $HERMES_HOME/config.yaml manually"
fi

# --- 2. Install the branded banner asset ----------------------------------
if [ -f "$OVERLAY_DIR/assets/banner.png" ] && [ -d "$SRC/assets" ]; then
  cp -f "$OVERLAY_DIR/assets/banner.png" "$SRC/assets/banner.png"
  echo "  ✓ asset   -> assets/banner.png"
fi

# --- 2b. JARVIS icon art (finding #23) -------------------------------------
# Three jobs:
#   a) Swap the desktop app's icon sources at apps/desktop/assets/icon.* —
#      the point electron-builder ("icon": "assets/icon") and the rcedit exe
#      stamp (scripts/set-exe-identity.mjs uses assets/icon.ico) read.
#      Rebuilt desktops then carry JARVIS art on every platform.
#      Recorded in the manifest (section 3) so updates revert them pre-pull.
#   b) Swap apps/desktop/public/apple-touch-icon.png — the RUNTIME icon.
#      electron/main.ts APP_ICON_PATHS resolves apple-touch-icon.png (public/,
#      dist/, or the asar-unpacked dist/) and feeds it to app.dock.setIcon()
#      on macOS and BrowserWindow {icon} elsewhere; index.html also uses it
#      as the favicon. assets/icon.* never reaches this path, so without this
#      swap the RUNNING app shows upstream art in the dock even though
#      Finder (bundle icon.icns) shows JARVIS. Vite copies public/ verbatim
#      into dist/ on rebuild; the dist copies are overwritten too so an
#      already-built tree is corrected even before its next rebuild.
#   c) Stage stable copies under $HERMES_HOME/.jarvis/ for shortcuts to
#      reference — .lnk IconLocation must point at a path that survives
#      rebuilds (the release/ dir is wiped) and repo cleanup.
ICON_DIR="$OVERLAY_DIR/installer/assets/icons"
ICON_PNG=""
for _p in "$ICON_DIR/icon-512.png" "$ICON_DIR/128x128@2x.png"; do
  [ -f "$_p" ] && { ICON_PNG="$_p"; break; }
done
if [ -d "$ICON_DIR" ] && [ -f "$ICON_DIR/icon.ico" ]; then
  DESK_ASSETS="$SRC/apps/desktop/assets"
  if [ -d "$DESK_ASSETS" ]; then
    cp -f "$ICON_DIR/icon.ico" "$DESK_ASSETS/icon.ico"
    [ -f "$ICON_DIR/icon.icns" ] && cp -f "$ICON_DIR/icon.icns" "$DESK_ASSETS/icon.icns"
    [ -n "$ICON_PNG" ] && cp -f "$ICON_PNG" "$DESK_ASSETS/icon.png"
    echo "  ✓ icons   -> apps/desktop/assets/icon.{ico,icns,png} (JARVIS art)"
  fi
  # (b) runtime dock/window icon + favicon (see header comment). dist copies
  # are best-effort: vite regenerates them from public/ on the next rebuild.
  if [ -n "$ICON_PNG" ]; then
    _touch_swapped=""
    if [ -f "$SRC/apps/desktop/public/apple-touch-icon.png" ]; then
      cp -f "$ICON_PNG" "$SRC/apps/desktop/public/apple-touch-icon.png"
      _touch_swapped=1
    fi
    if [ -f "$SRC/apps/desktop/dist/apple-touch-icon.png" ]; then
      cp -f "$ICON_PNG" "$SRC/apps/desktop/dist/apple-touch-icon.png"
      _touch_swapped=1
    fi
    [ -n "$_touch_swapped" ] && \
      echo "  ✓ icons   -> apps/desktop/{public,dist}/apple-touch-icon.png (runtime dock icon)"
  fi
  mkdir -p "$HERMES_HOME/.jarvis"
  cp -f "$ICON_DIR/icon.ico" "$HERMES_HOME/.jarvis/jarvis.ico"
  [ -f "$ICON_DIR/icon.icns" ] && cp -f "$ICON_DIR/icon.icns" "$HERMES_HOME/.jarvis/jarvis.icns"
  [ -n "$ICON_PNG" ] && cp -f "$ICON_PNG" "$HERMES_HOME/.jarvis/jarvis-icon.png"
  echo "  ✓ icons   -> $HERMES_HOME/.jarvis/ (stable path for shortcuts)"

  # (d) Force a repack when the SHIPPED bundle's runtime icons are stale.
  #
  # `jarvis desktop` skips the build when its content stamp matches, and that
  # stamp is a hash of apps/desktop/ MINUS everything .gitignore excludes —
  # which excludes apps/desktop/dist/. dist/apple-touch-icon.png is precisely
  # the file electron-builder packs into app.asar.unpacked and that
  # electron/main.ts feeds to the window/dock icon, so refreshing it here is
  # invisible to the stamp: the rebuild reports "up to date (content stamp
  # matches)" and the bundle keeps whatever icon it was packed with. That is
  # how a build shipped upstream art at runtime while every static surface
  # (exe resource, .lnk, Explorer) showed JARVIS.
  #
  # Rather than reach into upstream's hash, compare the PACKED artifacts to the
  # JARVIS art and drop the stamp when they disagree. Precise by construction:
  # a bundle that is already correct is left alone, so this never forces a
  # pointless multi-minute Electron rebuild.
  _stamp="$HERMES_HOME/desktop-build-stamp.json"
  _stale_icon=""
  for _rel in \
    "apps/desktop/release/win-unpacked/resources/app.asar.unpacked/dist/apple-touch-icon.png" \
    "apps/desktop/release/linux-unpacked/resources/app.asar.unpacked/dist/apple-touch-icon.png"; do
    _f="$SRC/$_rel"
    if [ -n "$ICON_PNG" ] && [ -f "$_f" ] && ! cmp -s "$_f" "$ICON_PNG"; then
      _stale_icon="$_rel"; break
    fi
  done
  # Windows taskbar icon: main.ts APP_ICON_PATHS puts resourcesPath/icon.ico
  # FIRST on Windows, so this — not the PNG — is what the taskbar shows.
  if [ -z "$_stale_icon" ] && [ -f "$SRC/apps/desktop/release/win-unpacked/resources/icon.ico" ]; then
    cmp -s "$SRC/apps/desktop/release/win-unpacked/resources/icon.ico" "$ICON_DIR/icon.ico" \
      || _stale_icon="apps/desktop/release/win-unpacked/resources/icon.ico"
  fi
  if [ -n "$_stale_icon" ] && [ -f "$_stamp" ]; then
    rm -f "$_stamp"
    echo "  ! packed bundle carries a stale runtime icon ($_stale_icon)"
    echo "    → dropped the desktop build stamp so the next build cannot skip"
  fi
else
  echo "  · no JARVIS icon set at installer/assets/icons — shortcuts fall back to the exe icon"
fi

# --- 2b. Close the in-app updater's de-branding hole -----------------------
# The Desktop's in-app self-update does NOT go through the jarvis shim. It runs
# scripts/desktop-update/windows.ps1, which drives the update with
#   python -m hermes_cli.main update ...
# deliberately bypassing venv\Scripts\hermes.exe (the script says why: the
# running shim is locked/quarantined mid-update). So the shim interception that
# protects `jarvis update` cannot see it, and the [command] rewrite cannot
# either — there is no `hermes update` command string to rewrite.
#
# The result is upstream's updater running unwrapped: it reverts the branded
# files, pulls, and repacks the Desktop from pristine source. Observed on
# 0.20.1 → 0.20.2: 241 files de-branded and the packed renderer shipped
# "HERMES AGENT".
#
# Fix: re-apply the overlay immediately after the update step, inside the
# updater itself — the same revert → update → re-apply order update-jarvis.sh
# uses, just driven from the other entry point. Inserted AFTER the retry block
# so both attempts are covered.
#
# The injected code is wrapped in try/catch and every lookup is guarded: if the
# overlay or Git Bash cannot be found it returns silently. A failed re-brand
# must never fail the user's update — an unbranded install is recoverable, a
# broken updater is not.
patch_inapp_updater() {
  local ps1="$SRC/scripts/desktop-update/windows.ps1"
  [ -f "$ps1" ] || return 0
  if grep -q 'Invoke-JarvisRebrand' "$ps1"; then
    echo "  ✓ in-app updater already re-brands after update (idempotent)"
    return 0
  fi
  local anchor='    # -- 4. Truthful completion'
  if ! grep -qF "$anchor" "$ps1"; then
    echo "  ⚠ in-app updater: anchor '# -- 4. Truthful completion' not found —"
    echo "    upstream reshaped windows.ps1; the in-app update path is NOT wrapped."
    INAPP_PATCH_FAILED=1
    return 0
  fi
  perl -i -pe '
    if (/^    # -- 4\. Truthful completion/ && !$done) {
      $done = 1;
      print <<"PSX";
    # --- JARVIS: re-apply branding after the unwrapped upstream update ------
    # Injected by the JARVIS overlay (apply.sh). The update above runs
    # upstream`s updater directly, which reverts every branded file. Re-apply
    # the overlay here so the install this updater is about to relaunch is
    # branded. Fully guarded: any failure leaves the update itself untouched.
    function Invoke-JarvisRebrand([string]\$Root) {
      try {
        \$ov = @("\$env:LOCALAPPDATA\\hermes\\jarvis-agent",
                "\$env:USERPROFILE\\.hermes\\jarvis-agent",
                "\$env:USERPROFILE\\jarvis\\jarvis-agent") |
               Where-Object { Test-Path (Join-Path \$_ "apply.sh") } | Select-Object -First 1
        if (-not \$ov) { Write-HandoffLog "jarvis: no overlay checkout found; skipping re-brand"; return }
        \$bash = @("\$env:ProgramFiles\\Git\\bin\\bash.exe",
                  "\$env:LOCALAPPDATA\\Programs\\Git\\bin\\bash.exe") |
                 Where-Object { Test-Path \$_ } | Select-Object -First 1
        if (-not \$bash) { Write-HandoffLog "jarvis: no Git Bash found; skipping re-brand"; return }
        \$env:HERMES_SRC = (\$Root -replace "\\\\", "/")
        \$applySh = ((Join-Path \$ov "apply.sh") -replace "\\\\", "/")
        Write-HandoffLog "jarvis: re-applying branding via \$applySh"
        & \$bash \$applySh 2>&1 | ForEach-Object { Write-HandoffLog "jarvis: \$_" }
        Write-HandoffLog "jarvis: re-brand exit \$LASTEXITCODE"
      } catch {
        Write-HandoffLog "jarvis: re-brand failed (\$(\$_.Exception.Message)); update itself is unaffected"
      }
    }
    Invoke-JarvisRebrand \$InstallRoot

PSX
    }
  ' "$ps1"
  if grep -q 'Invoke-JarvisRebrand' "$ps1"; then
    echo "  ✓ in-app updater patched to re-brand after updating"
  else
    echo "  ⚠ in-app updater patch did not apply — the in-app path stays unwrapped"
    INAPP_PATCH_FAILED=1
  fi
}
# --- 2c. The SAME hole on macOS/Linux: scripts/desktop-update/posix.sh ------
# patch_inapp_updater above only covers windows.ps1. The macOS handoff runs
# "$INSTALL_ROOT/venv/bin/hermes" update directly (posix.sh — the shim is
# never consulted), so a divergence-reset update leaves the tree pristine,
# repacks the renderer from it, and swaps an unbranded bundle into
# /Applications. Observed live 2026-08-19 (0.20.3 → 0.20.4, 261 commits,
# "Fast-forward not possible… resetting to match remote"): stash-restore
# conflicted, tree reset pristine, HERMES AGENT home view shipped on glass.
# Same remedy as Windows, injected before the truthful-completion block so
# the bundle the handoff swaps is rebuilt from BRANDED source. Fully guarded:
# a failed re-brand never fails the user's update.
patch_inapp_updater_posix() {
  local psx="$SRC/scripts/desktop-update/posix.sh"
  [ -f "$psx" ] || return 0
  if grep -q 'jarvis_rebrand' "$psx"; then
    echo "  ✓ posix in-app updater already re-brands after update (idempotent)"
    return 0
  fi
  local anchor='# Truthful completion:'
  if ! grep -qF "$anchor" "$psx"; then
    echo "  ⚠ posix in-app updater: anchor '# Truthful completion:' not found —"
    echo "    upstream reshaped posix.sh; the macOS in-app update path is NOT wrapped."
    INAPP_PATCH_FAILED=1
    return 0
  fi
  perl -i -pe '
    if (/^# Truthful completion:/ && !$done) {
      $done = 1;
      print <<"SH";
# --- JARVIS: re-apply branding after the unwrapped upstream update ----------
# Injected by the JARVIS overlay (apply.sh). The update above runs upstream\x27s
# updater directly; a divergence reset leaves the tree pristine and the
# renderer repack ships it. Re-brand, then rebuild so the bundle the swap
# ships is branded. Guarded: any failure leaves the update itself untouched.
jarvis_rebrand() {
  _ov=""
  for _c in "\$HOME/.hermes/jarvis-agent" "\$HOME/jarvis/jarvis-agent"; do
    [ -f "\$_c/apply.sh" ] && { _ov="\$_c"; break; }
  done
  if [ -z "\$_ov" ]; then log "jarvis: no overlay checkout found; skipping re-brand"; return 0; fi
  log "jarvis: re-applying branding via \$_ov/apply.sh"
  if ( HERMES_SRC="\$INSTALL_ROOT" bash "\$_ov/apply.sh" ) >> "\$LOG" 2>&1; then
    log "jarvis: re-brand OK"
  else
    log "jarvis: re-brand exit \$? — update itself is unaffected"
    return 0
  fi
  if [ -d "\$INSTALL_ROOT/apps/desktop/release" ]; then
    if "\$HERMES_BIN" desktop --force-build --build-only >> "\$LOG" 2>&1; then
      log "jarvis: desktop rebuilt from branded source"
    else
      log "jarvis: desktop rebuild failed — bundle may show upstream branding until the next update"
    fi
  fi
  return 0
}
jarvis_rebrand || true

SH
    }
  ' "$psx"
  if grep -q 'jarvis_rebrand' "$psx"; then
    echo "  ✓ posix in-app updater patched to re-brand after updating"
  else
    echo "  ⚠ posix in-app updater patch did not apply — the macOS in-app path stays unwrapped"
    INAPP_PATCH_FAILED=1
  fi
}

INAPP_PATCH_FAILED=0
patch_inapp_updater
patch_inapp_updater_posix

# --- 3. Rewrite customer-visible strings ----------------------------------
# One proven-safe profile applies every rule class from branding.map.
rewrite() {
  perl -CSDA -Mstrict -Mwarnings - "$MAP" "$@" <<'PERL'
use strict; use warnings;
my ($map, @files) = @ARGV;

my (@protect, @literal, @regex, @command, @word, @glyph);
open(my $m, '<:encoding(UTF-8)', $map) or die "cannot read map: $!";
my $sec = '';
while (my $l = <$m>) {
    chomp $l;
    next if $l =~ /^\s*#/ || $l =~ /^\s*$/;
    if ($l =~ /^\[(\w+)\]\s*$/) { $sec = $1; next; }
    if ($sec eq 'protect') { push @protect, $l; next; }
    my ($f, $r) = split(/\t/, $l, 2);
    next unless defined $f;
    $r = '' unless defined $r;
    push @literal, [$f,$r] if $sec eq 'literal';
    push @regex,   [$f,$r] if $sec eq 'regex';
    push @command, [$f,$r] if $sec eq 'command';
    push @word,    [$f,$r] if $sec eq 'word';
    push @glyph,   [$f,$r] if $sec eq 'glyph';
}
close $m;

my $changed = 0;
for my $file (@files) {
    next unless -f $file;
    local $/; open(my $fh, '<:encoding(UTF-8)', $file) or next;
    my $orig = <$fh>; close $fh;
    my $s = $orig;

    my @saved;                                    # mask protected tokens
    for my $tok (@protect) {
        my $ph = "\x00" . scalar(@saved) . "\x00";
        push @saved, $tok;
        my $q = quotemeta $tok;
        $s =~ s/$q/$ph/g;
    }
    for my $p (@literal) { my $q = quotemeta $p->[0]; $s =~ s/$q/$p->[1]/g; }
    for my $p (@regex)   { my $re = $p->[0];          $s =~ s/$re/$p->[1]/g; }
    for my $p (@command) { my $re = $p->[0];          $s =~ s/$re/$p->[1]/g; }
    # Proper-noun boundary keyed off ASCII letters/digits only, so the brand
    # rebrands even when glued to non-Latin script (Korean "Hermes가",
    # Chinese, Japanese) or hyphenated compounds ("Hermes-Plugins"), while
    # Latin identifiers ("HermesCLI", "updateHermes") stay intact.
    for my $p (@word)    { my $q = quotemeta $p->[0]; $s =~ s/(?<![A-Za-z0-9_])$q(?![A-Za-z0-9_])/$p->[1]/g; }
    for my $p (@glyph)   { my $q = quotemeta $p->[0]; $s =~ s/$q/$p->[1]/g; }
    for (my $i = 0; $i < @saved; $i++) {          # unmask
        my $ph = quotemeta("\x00$i\x00"); $s =~ s/$ph/$saved[$i]/g;
    }

    if ($s ne $orig) {
        open(my $out, '>:encoding(UTF-8)', $file) or die "cannot write $file: $!";
        print $out $s; close $out;
        my $short = $file; $short =~ s{.*/([^/]+/[^/]+)$}{$1};
        $changed++; print "    ~ $short\n";
    }
}
print "  rewrote $changed file(s)\n";
PERL
}

# Curated customer-visible surface. Globs adapt if upstream adds locale files.
echo "  rewriting customer-visible strings…"
FILES=()
# Skip curated files this tree does not have, and REPORT them rather than
# swallowing them silently.
#
# The `return 0` is load-bearing. `add() { [ -f "$1" ] && FILES+=("$1"); }`
# returns the status of the failed test when the file is absent, and under
# `set -e` a function returning non-zero as a simple command kills the script
# instantly and without a word. That is precisely how apply.sh died right after
# "rewriting customer-visible strings…" on an older upstream checkout that
# predates hermes_cli/_startup_fast.py — a file the curated list gained in
# v1.1.2. Every curated entry is a landmine on any tree that lacks it.
#
# Absent files are legitimate: the overlay supports a range of upstream
# revisions and not every revision has every file. But a MISSING entry can also
# mean upstream renamed something and the branding silently stopped applying,
# so the count is surfaced after the rewrite instead of being invisible.
MISSING_CURATED=()
add() {
  if [ -f "$1" ]; then
    FILES+=("$1")
  else
    MISSING_CURATED+=("${1#"$SRC"/}")
  fi
  return 0
}
# Dashboard (React app + server-side strings it renders)
add "$SRC/web/index.html"
add "$SRC/web/src/App.tsx"
add "$SRC/web/src/themes/presets.ts"
while IFS= read -r f; do FILES+=("$f"); done < <(
  find "$SRC/web/src/i18n" -maxdepth 1 -name '*.ts' \
    ! -name 'index.ts' ! -name 'context.tsx' ! -name 'types.ts' 2>/dev/null || true)
# Chat catalogs (Telegram/Matrix/Discord/etc. — all languages)
while IFS= read -r f; do FILES+=("$f"); done < <(
  find "$SRC/locales" -maxdepth 1 -name '*.yaml' 2>/dev/null || true)
# Hardcoded brand strings the skin cannot reach (CLI + dashboard server + chat gateways)
for f in \
  hermes_cli/web_server.py hermes_cli/banner.py hermes_cli/_parser.py \
  hermes_cli/commands.py hermes_cli/__init__.py hermes_cli/auth.py \
  hermes_cli/cli_commands_mixin.py hermes_cli/config.py hermes_cli/gateway.py \
  hermes_cli/claw.py cli.py \
  hermes_cli/_startup_fast.py \
  gateway/platforms/whatsapp_common.py gateway/platforms/qqbot/adapter.py \
  gateway/run.py \
  hermes_cli/status.py hermes_cli/setup.py hermes_cli/doctor.py \
  hermes_cli/uninstall.py hermes_cli/update_cmd.py \
  hermes_cli/cli_billing_mixin.py hermes_cli/main.py \
  hermes_cli/dashboard_auth/login_page.py hermes_cli/session_export_html.py \
  hermes_cli/completion.py hermes_cli/gateway_windows.py \
  hermes_cli/pty_bridge.py hermes_cli/kanban_db.py \
  hermes_cli/projects_cmd.py hermes_cli/model_switch.py \
  hermes_cli/default_soul.py \
  hermes_cli/kanban_decompose.py hermes_cli/kanban_specify.py \
  hermes_cli/profile_describer.py \
  gateway/relay/command_manifest.py gateway/slash_commands.py \
  mcp_serve.py tools/environments/local.py \
  agent/prompt_builder.py agent/agent_init.py \
  agent/transports/hermes_tools_mcp_server.py \
  acp_adapter/entry.py acp_adapter/server.py \
  ui-tui/src/theme.ts ui-tui/src/app/slash/commands/core.ts \
  ui-tui/src/app/slash/commands/topup.ts ui-tui/src/components/billingOverlay.tsx \
  scripts/whatsapp-bridge/bridge.js \
  plugins/memory/hindsight/__init__.py \
  plugins/google_meet/cli.py plugins/google_meet/meet_bot.py \
  plugins/google_meet/node/client.py plugins/google_meet/process_manager.py \
  plugins/google_meet/tools.py \
  plugins/platforms/a2a/adapter.py plugins/platforms/a2a/protocol.py \
  plugins/platforms/discord/adapter.py plugins/platforms/email/adapter.py \
  plugins/platforms/irc/adapter.py plugins/platforms/matrix/adapter.py \
  plugins/platforms/homeassistant/adapter.py \
  optional-skills/blockchain/hyperliquid/scripts/hyperliquid_client.py \
  optional-skills/blockchain/solana/scripts/solana_client.py \
  optional-skills/finance/stocks/scripts/stocks_client.py \
  optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py \
  optional-skills/productivity/canvas/scripts/canvas_api.py \
  skills/productivity/google-workspace/scripts/google_api.py \
  scripts/desktop-update/ui.html scripts/desktop-update/windows.ps1 \
  scripts/desktop-update/posix.sh \
  apps/desktop/index.html apps/desktop/dist/index.html; do
  add "$SRC/$f"
done
# `hermes <verb> --help` descriptions: every subcommand module carries an
# argparse help/description string with the brand in it.
while IFS= read -r f; do FILES+=("$f"); done < <(
  find "$SRC/hermes_cli/subcommands" -maxdepth 1 -name '*.py' 2>/dev/null || true)

# The SHIPPED dashboard bundle (hermes_cli/web_dist). This is what the web
# dashboard actually serves — web/src is only its source. It is untracked build
# output, so `git checkout --` during an update does NOT restore it and the
# revert/re-apply cycle never covered it: upstream 0.20.2 shipped a fresh
# pristine bundle and the dashboard's browser tab went back to reading
# "Hermes Agent - Dashboard". Filenames carry a content hash, so match by glob.
#
# Safe to rebrand despite being minified: the [word] rule is boundary-guarded,
# so standalone "Hermes" inside prose strings is rewritten while glued
# identifiers (updateHermes — also [protect]ed — updatingHermes, HermesCLI)
# cannot match.
while IFS= read -r f; do FILES+=("$f"); done < <(
  find "$SRC/hermes_cli/web_dist" \( -name '*.js' -o -name '*.html' \) 2>/dev/null || true)
# Desktop (Electron) RENDERER (apps/desktop/src) — blanket-rebrand every file
# that mentions the brand. Blanket-safe: the renderer has no functional
# capitalized "Hermes" and no Hermes.app/.exe bundle paths (those live only in
# electron/*, handled surgically below). Grep-filter so only files that
# actually carry a brand string enter the manifest.
if [ -d "$SRC/apps/desktop/src" ]; then
  while IFS= read -r f; do FILES+=("$f"); done < <(
    grep -rlE '\bHermes\b|HERMES AGENT' "$SRC/apps/desktop/src" \
      --include='*.ts' --include='*.tsx' --include='*.jsonl' 2>/dev/null \
      | grep -vE '\.test\.|\.spec\.' || true)
fi

# Drop any operator-excluded files, and record the branded set to a manifest
# so update-jarvis.sh can revert ONLY these files (never unrelated local work).
MANIFEST_DIR="$HERMES_HOME/.jarvis"; mkdir -p "$MANIFEST_DIR"
MANIFEST="$MANIFEST_DIR/$(manifest_name "$SRC")"
# Keep the previous manifest for a union-merge below: on an ALREADY-branded
# tree the grep-selection only finds files still carrying functional Hermes
# tokens, so writing the manifest fresh would silently drop the visible-string
# files from the revert list and the next pre-pull revert would miss them.
OLD_MANIFEST="$(cat "$MANIFEST" 2>/dev/null || true)"
: > "$MANIFEST"
FILTERED=(); SKIPPED=0
for f in "${FILES[@]:-}"; do
  [ -z "$f" ] && continue
  rel="${f#"$SRC"/}"
  if is_excluded "$rel"; then SKIPPED=$((SKIPPED + 1)); continue; fi
  FILTERED+=("$f"); echo "$rel" >> "$MANIFEST"
done
FILES=("${FILTERED[@]:-}")
[ "$SKIPPED" -gt 0 ] && echo "  · excluded $SKIPPED operator-maintained file(s) from branding"
# (#18/#23) Binary assets the overlay writes into the source tree are part of
# the branded set: record them so update-jarvis.sh (and the Setup path's
# pre-update revert) restore pristine upstream before the pull, instead of
# leaving autostash churn. git checkout no-ops harmlessly if untracked.
for _asset in assets/banner.png \
              apps/desktop/assets/icon.ico apps/desktop/assets/icon.icns \
              apps/desktop/assets/icon.png \
              apps/desktop/public/apple-touch-icon.png; do
  [ -f "$SRC/$_asset" ] || continue
  is_excluded "$_asset" && continue
  # Only tracked files: the Setup path reverts the manifest in ONE batched
  # `git checkout -- <paths>`, which fails wholesale on an untracked pathspec.
  git -C "$SRC" ls-files --error-unmatch "$_asset" >/dev/null 2>&1 || continue
  echo "$_asset" >> "$MANIFEST"
done
# Union-merge the previous manifest (see OLD_MANIFEST note above) so a
# re-apply never shrinks the revert list while the branding is in place.
if [ -n "$OLD_MANIFEST" ]; then
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    [ -f "$SRC/$rel" ] || continue
    is_excluded "$rel" && continue
    grep -qxF "$rel" "$MANIFEST" || echo "$rel" >> "$MANIFEST"
  done <<< "$OLD_MANIFEST"
fi
# `[ ... ] && rewrite ...` would itself return non-zero when FILES is empty and
# take the whole script down under set -e. Use a real if.
if [ ${#FILES[@]} -gt 0 ]; then
  rewrite "${FILES[@]}"
fi

# Curated entries this tree does not have. Not fatal — the overlay spans a range
# of upstream revisions — but if the count is large or a file you expect is
# listed, upstream probably moved it and that surface is no longer branded.
if [ ${#MISSING_CURATED[@]} -gt 0 ]; then
  echo "  · ${#MISSING_CURATED[@]} curated file(s) absent from this tree (skipped):"
  printf '      %s\n' "${MISSING_CURATED[@]}" | head -12
  if [ ${#MISSING_CURATED[@]} -gt 12 ]; then
    echo "      … and $(( ${#MISSING_CURATED[@]} - 12 )) more"
  fi
  echo "    (expected on older upstream revisions; if one looks wrong, upstream"
  echo "     may have renamed it and that surface is no longer being branded.)"
fi

# --- 3b. Desktop build-config — surgical, key-anchored [desktop] literals ---
# Applied ONLY to package.json + electron/main.ts. Each pattern includes its
# JSON key / code context so it rebrands the visible app name
# (CFBundleDisplayName, dmg title, permission text, app.setName default)
# without ever matching the protected productName/executableName/
# CFBundleExecutable/CFBundleName/appId on adjacent lines. CFBundleName is
# protected because Electron derives macOS helper-app names from it
# (electron_main_delegate_mac.mm) while electron-builder names the helpers
# from productName — a mismatch crashes at launch ("Unable to find helper
# app"). Independent JSON validity is asserted after the edit.
rewrite_desktop_config() {
  perl -CSDA -Mstrict -Mwarnings - "$MAP" "$@" <<'PERL'
use strict; use warnings;
my ($map, @files) = @ARGV;
my @pairs;
open(my $m, '<:encoding(UTF-8)', $map) or die "cannot read map: $!";
my $sec = '';
while (my $l = <$m>) {
    chomp $l;
    next if $l =~ /^\s*#/ || $l =~ /^\s*$/;
    if ($l =~ /^\[(\w+)\]\s*$/) { $sec = $1; next; }
    next unless $sec eq 'desktop';
    my ($f, $r) = split(/\t/, $l, 2);
    push @pairs, [$f, $r] if defined $f && defined $r;
}
close $m;
my $changed = 0;
for my $file (@files) {
    next unless -f $file;
    local $/; open(my $fh, '<:encoding(UTF-8)', $file) or next;
    my $orig = <$fh>; close $fh; my $s = $orig;
    for my $p (@pairs) { my $q = quotemeta $p->[0]; $s =~ s/$q/$p->[1]/g; }
    if ($s ne $orig) {
        open(my $out, '>:encoding(UTF-8)', $file) or die "cannot write $file: $!";
        print $out $s; close $out;
        my $short = $file; $short =~ s{.*/(apps/desktop/.*)$}{$1};
        $changed++; print "    ~ $short\n";
    }
}
print "  (desktop) rewrote $changed file(s)\n";
PERL
}
# Surgical set: package.json + EVERY electron/*.ts that mentions the brand.
# The [desktop] literals are context-anchored, so applying them across all
# electron files only ever touches visible strings ("Hermes Agent", window
# titles, app-name fallbacks) — never the functional Hermes.app/.exe/MacOS/Hermes
# paths those same files use to drive the updater/uninstaller.
DESK_CFG=()
desk_add_cfg() {
  local rel="$1"
  [ -f "$SRC/$rel" ] || return 0
  is_excluded "$rel" && return 0
  DESK_CFG+=("$SRC/$rel"); echo "$rel" >> "$MANIFEST"
}
desk_add_cfg "apps/desktop/package.json"
if [ -d "$SRC/apps/desktop/electron" ]; then
  while IFS= read -r f; do desk_add_cfg "${f#"$SRC"/}"; done < <(
    grep -rlE '\bHermes\b|HERMES AGENT' "$SRC/apps/desktop/electron" \
      --include='*.ts' 2>/dev/null | grep -vE '\.test\.|\.spec\.' || true)
fi
DESK_PKG="$SRC/apps/desktop/package.json"
if [ ${#DESK_CFG[@]} -gt 0 ]; then
  echo "  rewriting desktop build config…"
  rewrite_desktop_config "${DESK_CFG[@]}"
  # Assert package.json is still valid JSON after the surgical edit.
  if [ -f "$DESK_PKG" ] && [ -n "$PY" ]; then
    if ! "$PY" -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" "$DESK_PKG" 2>/dev/null; then
      echo "  ✗ desktop package.json is no longer valid JSON after edit — aborting" >&2
      exit 1
    fi
    echo "  ✓ desktop package.json still valid JSON"
  fi
fi

# --- 3c. macOS menu-bar name (localized CFBundleName) ----------------------
# The macOS app menu takes its title from the bundle's LOCALIZED CFBundleName
# (Resources/en.lproj/InfoPlist.strings), while Electron's helper-app lookup
# reads the RAW Info.plist value. CFBundleName must stay "Hermes" for that
# lookup (see rewrite_desktop_config above), so the menu bar read "Hermes"
# beside a fully branded window. A localized override renames the menu
# without touching what Chromium resolves: display changes, lookup does not.
if [ -d "$SRC/apps/desktop" ]; then
  mkdir -p "$SRC/apps/desktop/build/en.lproj"
  _lproj="$SRC/apps/desktop/build/en.lproj/InfoPlist.strings"
  printf 'CFBundleName = "JARVIS";\nCFBundleDisplayName = "JARVIS";\n' > "$_lproj.tmp"
  if ! cmp -s "$_lproj.tmp" "$_lproj" 2>/dev/null; then
    mv -f "$_lproj.tmp" "$_lproj"
    echo "  ✓ menu-bar name: build/en.lproj/InfoPlist.strings -> JARVIS"
  else
    rm -f "$_lproj.tmp"
  fi
  # Ship it: extraResources lands in Contents/Resources on macOS. Idempotent —
  # a no-op when the entry is already in package.json.
  if [ -n "$PY" ] && [ -f "$DESK_PKG" ]; then
    "$PY" - "$DESK_PKG" <<'PYEOF'
import json, sys
path = sys.argv[1]
pkg = json.load(open(path, encoding="utf-8"))
extra = pkg.setdefault("build", {}).setdefault("extraResources", [])
entry = {"from": "build/en.lproj", "to": "en.lproj"}
if entry not in extra:
    extra.append(entry)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(pkg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print("  ✓ menu-bar name: extraResources ships en.lproj into the bundle")
PYEOF
  fi
fi

# --- 3d. Updater-splash brand mark ------------------------------------------
# The splash's animated loader is upstream's signature Fourier-curve mark —
# the TEXT was branded in v1.1.5 but the glyph still read as upstream's.
# Swap the svg mount for the JARVIS mark (data-URI, offline-safe) with a CSS
# pulse. Guarded on the upstream mount line, so it is idempotent and simply
# skips (verify below flags it) if upstream reshapes the splash.
_splash="$SRC/scripts/desktop-update/ui.html"
_mark_png=""
for _p in "$OVERLAY_DIR/installer/assets/icons/128x128.png" \
          "$OVERLAY_DIR/installer/assets/icons/icon-512.png"; do
  [ -f "$_p" ] && { _mark_png="$_p"; break; }
done
if [ -f "$_splash" ] && [ -n "$_mark_png" ] && [ -n "$PY" ] \
   && grep -q "appendChild(svg)" "$_splash"; then
  "$PY" - "$_splash" "$_mark_png" <<'PYEOF'
import base64, sys
path, png = sys.argv[1], sys.argv[2]
s = open(path, encoding="utf-8").read()
b64 = base64.b64encode(open(png, "rb").read()).decode()
anchor = ".wrap { animation: hermes-fade-in 0.45s ease-out both; }"
pulse = (anchor
         + "\n  /* jarvis-splash-mark */"
         + "\n  #loader img { width: 100%; height: 100%; object-fit: contain;"
         + " animation: jarvis-pulse 2.2s ease-in-out infinite; }"
         + "\n  @keyframes jarvis-pulse { 0%, 100% { opacity: .55;"
         + " transform: scale(.96); } 50% { opacity: 1; transform: scale(1); } }")
if "jarvis-splash-mark" not in s:
    s = s.replace(anchor, pulse, 1)
mount = "document.getElementById('loader').appendChild(svg)"
mark = ("{ const mark = document.createElement('img'); mark.alt = ''; "
        "mark.src = 'data:image/png;base64," + b64 + "'; "
        "document.getElementById('loader').appendChild(mark) }")
s = s.replace(mount, mark, 1)
s = s.replace("render(performance.now())",
              "/* svg loader not mounted: JARVIS mark pulses via CSS */", 1)
open(path, "w", encoding="utf-8").write(s)
print("  ✓ splash: upstream loader glyph -> JARVIS mark")
PYEOF
fi

# --- 4. Verify pass -------------------------------------------------------
# Grep EVERY customer-visible surface for a surviving standalone brand token.
# Locale files (dashboard i18n + chat catalogs) are pure visible strings, so
# any hit there is a real leak. Case-sensitive "Hermes" (brand form) plus an
# all-caps "HERMES" check (minus HERMES_* identifiers), minus protected tokens.
echo
echo "◆ JARVIS overlay — verify"
LEAKS=0
scan() {
  local label="$1"; shift
  local f hits
  for f in "$@"; do
    [ -f "$f" ] || continue
    # The second grep drops [protect]ed identifiers — they are SUPPOSED to
    # survive, so they are not leaks. "Hermes 3/4" is Nous's LLM family, not
    # the product: rebranding it would state something untrue about models we
    # do not ship (see branding.map [protect]).
    hits="$(grep -nE '\bHermes\b|NOUS HERMES|HERMES AGENT' "$f" 2>/dev/null \
            | grep -vE 'X-Hermes-|HermesCLI|updateHermes|checkHermesUpdate|can_update_hermes' \
            | grep -vE 'Hermes [34]\b' \
            | grep -vE 'Hermes\.(exe|app|icns|ico)|MacOS/Hermes' || true)"
    if [ -n "$hits" ]; then
      LEAKS=$(( LEAKS + $(printf '%s\n' "$hits" | grep -c .) ))
      echo "  ⚠ [$label] leak in ${f#"$SRC"/}:"
      printf '%s\n' "$hits" | sed 's/^/      /'
    fi
  done
}

# ALL locale files — dashboard i18n + chat catalogs (per requirement).
I18N=(); while IFS= read -r f; do I18N+=("$f"); done < <(
  find "$SRC/web/src/i18n" -maxdepth 1 -name '*.ts' \
    ! -name 'index.ts' ! -name 'context.tsx' ! -name 'types.ts' 2>/dev/null || true)
YAML=(); while IFS= read -r f; do YAML+=("$f"); done < <(
  find "$SRC/locales" -maxdepth 1 -name '*.yaml' 2>/dev/null || true)
echo "  scanning ${#I18N[@]} dashboard i18n + ${#YAML[@]} chat-catalog locale files…"
scan "dashboard-i18n" "${I18N[@]}"
scan "chat-catalog"   "${YAML[@]}"
scan "web"            "$SRC/web/index.html" "$SRC/web/src/App.tsx" "$SRC/web/src/themes/presets.ts"
scan "cli/gateway"    \
  "$SRC/hermes_cli/web_server.py" "$SRC/hermes_cli/banner.py" \
  "$SRC/hermes_cli/commands.py"   "$SRC/hermes_cli/cli_commands_mixin.py" \
  "$SRC/gateway/platforms/whatsapp_common.py" "$SRC/cli.py" \
  "$SRC/hermes_cli/_startup_fast.py"

# The in-app updater's own splash. This is the LAST thing a user sees before
# the app restarts, and it ran unbranded for the whole 0.20.x line: window
# title "Hermes", "Updating Hermes", "Hermes will open once done" — from
# scripts/desktop-update/ui.html (served in an Edge window) and the WinForms
# fallback card in windows.ps1.
#
# It is scanned HERE rather than left to tests/brand_scan.py because that
# scanner deliberately searches for "Hermes Agent" — bare "Hermes" appears in
# paths and identifiers everywhere, so it cannot be a needle there. This scan
# greps \bHermes\b, which is exactly what catches this class. If upstream
# reshapes the updater UI, this fails instead of shipping silently.
scan "updater-ui" \
  "$SRC/scripts/desktop-update/ui.html" \
  "$SRC/scripts/desktop-update/windows.ps1" \
  "$SRC/scripts/desktop-update/posix.sh"

# The SHIPPED dashboard bundle — what the browser actually loads.
scan "dashboard-dist" "$SRC/hermes_cli/web_dist/index.html"

# Desktop renderer surfaces (i18n + intro) — pure visible strings.
DESKI18N=(); while IFS= read -r f; do DESKI18N+=("$f"); done < <(
  find "$SRC/apps/desktop/src/i18n" -maxdepth 1 -name '*.ts' \
    ! -name 'catalog.ts' ! -name 'context.tsx' ! -name 'define-locale.ts' \
    ! -name 'index.ts' ! -name 'languages.ts' ! -name 'runtime.ts' \
    ! -name 'types.ts' ! -name '*.test.*' 2>/dev/null || true)
[ ${#DESKI18N[@]} -gt 0 ] && scan "desktop-i18n" "${DESKI18N[@]}"
scan "desktop-ui" \
  "$SRC/apps/desktop/src/components/chat/intro.tsx" \
  "$SRC/apps/desktop/src/components/chat/intro-copy.jsonl"

# Desktop build config — assert visible fields rebranded AND that the
# protected functional identifiers are STILL "Hermes" (a change here would
# break Hermes's own updater, which hardcodes Hermes.app/Hermes.exe, or —
# for CFBundleName — Electron's helper-app lookup, which derives
# "<CFBundleName> Helper*.app" names that must match the productName-named
# helpers electron-builder puts in Contents/Frameworks).
DESK_PKG="$SRC/apps/desktop/package.json"
if [ -f "$DESK_PKG" ]; then
  cfg_bad() { echo "  ⚠ [desktop-config] $1"; LEAKS=$((LEAKS + 1)); }
  grep -q '"CFBundleDisplayName": "JARVIS"' "$DESK_PKG" || cfg_bad "CFBundleDisplayName not rebranded to JARVIS"
  grep -q '"CFBundleName": "Hermes"'        "$DESK_PKG" || cfg_bad "CFBundleName changed from Hermes — Electron helper-app lookup will break at launch!"
  grep -q '"productName": "Hermes"'         "$DESK_PKG" || cfg_bad "productName changed from Hermes — bundle/updater name drift!"
  grep -q '"executableName": "Hermes"'      "$DESK_PKG" || cfg_bad "executableName changed from Hermes — updater relaunch will break!"
  grep -q "|| 'JARVIS'" "$SRC/apps/desktop/electron/main.ts" 2>/dev/null || cfg_bad "main.ts APP_NAME default not rebranded to JARVIS"
  if grep -q '"Hermes uses the camera' "$DESK_PKG"; then
    cfg_bad "camera permission text still says Hermes (visible macOS permission dialog)"
  fi
  grep -q '"to": "en.lproj"' "$DESK_PKG" || cfg_bad "extraResources missing en.lproj — macOS menu bar will read Hermes"
  if [ -f "$SRC/apps/desktop/build/en.lproj/InfoPlist.strings" ]; then
    grep -q 'CFBundleName = "JARVIS"' "$SRC/apps/desktop/build/en.lproj/InfoPlist.strings" \
      || cfg_bad "InfoPlist.strings present but CFBundleName is not JARVIS"
  else
    cfg_bad "build/en.lproj/InfoPlist.strings missing — macOS menu bar will read Hermes"
  fi
  if [ -f "$SRC/scripts/desktop-update/ui.html" ]; then
    grep -q 'jarvis-splash-mark' "$SRC/scripts/desktop-update/ui.html" \
      || cfg_bad "updater splash still mounts upstream's loader glyph"
  fi
fi

if [ "$LEAKS" -gt 0 ]; then
  echo
  echo "  ##################################################################"
  printf '  # WARNING: %-3d visible brand string(s) survived the rebrand!      #\n' "$LEAKS"
  echo "  # Review the lines above and extend branding.map, then re-apply.  #"
  echo "  ##################################################################"
  echo
else
  echo "  ✓ no visible brand strings survived across the curated surfaces"
fi

# --- 4b. Tree-wide brand scan ----------------------------------------------
# The check above walks the SAME curated list apply.sh brands, so it can only
# ever confirm what we already thought of — a brand string in a file nobody
# listed is invisible to it. That is exactly how upstream v0.20.1's
# _startup_fast.py put "Hermes Agent" back into `hermes --version` while this
# pass still reported success. brand_scan.py walks the entire tree instead, so
# a new upstream file fails here the day it lands. Anything legitimately
# exempt is justified in branding-known-ok.txt.
if [ -n "${PY:-}" ] && [ -f "$OVERLAY_DIR/tests/brand_scan.py" ]; then
  echo
  if ! "$PY" "$OVERLAY_DIR/tests/brand_scan.py" "$SRC"; then
    LEAKS=$((LEAKS + 1))
    echo "  ⚠ tree-wide brand scan found unaccounted strings (see above)"
  fi
else
  echo "  · tree-wide brand scan skipped (no python / scanner not found)"
fi

# --- 4c. Realtime voice feature layer --------------------------------------
# The overlay's SECOND mechanism (alongside branding): layer the configurable
# OpenAI Realtime speech-to-speech voice assistant onto the pristine tree —
# new source files + a focused tracked-file patch + documented config defaults.
# Idempotent. It FAILS LOUDLY on upstream drift and ships nothing partial (it
# refuses to half-apply). A voice-feature drift is surfaced as a prominent
# warning here but does NOT fail the whole rebrand — the CLI/dashboard install
# must still succeed; the drift is caught (and fails) in CI + the feature test.
FEATURE_APPLY="$OVERLAY_DIR/features/realtime-voice/apply-feature.sh"
if [ -f "$FEATURE_APPLY" ]; then
  echo
  if HERMES_SRC="$SRC" HERMES_HOME="$HERMES_HOME" bash "$FEATURE_APPLY" apply "$SRC"; then
    :
  else
    echo "  ⚠ realtime-voice feature did NOT apply (see the drift banner above)." >&2
    echo "    Branding is complete; voice support stays inert until the patch is" >&2
    echo "    rebuilt against current upstream (features/realtime-voice/README.md)." >&2
  fi
fi

# --- 4d. JARVIS desktop appearance default ---------------------------------
APPEARANCE_APPLY="$OVERLAY_DIR/features/jarvis-appearance/apply-feature.sh"
if [ -f "$APPEARANCE_APPLY" ]; then
  echo
  HERMES_SRC="$SRC" HERMES_HOME="$HERMES_HOME" bash "$APPEARANCE_APPLY" apply "$SRC" \
    || echo "  ⚠ JARVIS appearance default did not apply; existing theme behavior remains intact." >&2
fi

# --- 5. Cascade onto the desktop app's ACTIVE source tree -------------------
# See the ACTIVE_ROOT note near the top: the Electron app's in-app updater
# rebuilds from $HERMES_HOME/hermes-agent and dittos the result over the
# installed .app. An unbranded active tree means any self-update replaces the
# branded desktop with pristine HERMES (splash, icon) — observed live 2026-07-16.
if [ -z "${JARVIS_APPLY_NO_CASCADE:-}" ] && [ -n "$ACTIVE_ROOT" ] && [ "$ACTIVE_ROOT" != "$SRC" ]; then
  echo
  echo "◆ JARVIS overlay — cascading to the desktop app's active tree"
  echo "  $ACTIVE_ROOT self-rebuilds the installed app; branding it too."
  JARVIS_APPLY_NO_CASCADE=1 HERMES_SRC="$ACTIVE_ROOT" HERMES_HOME="$HERMES_HOME" \
    bash "$OVERLAY_DIR/apply.sh"
fi

echo "◆ JARVIS overlay — done"
