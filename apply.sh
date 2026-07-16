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
set -euo pipefail

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
      echo "  ⚠ $name packs upstream RUNTIME icon (unpacked dist/apple-touch-icon.png ≠ JARVIS art) — dock shows upstream while running"
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
  if [ "${JARVIS_CHECK_LAUNCH_POINTS:-}" = "1" ]; then
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
  verify_desktop_build "$SRC"
  exit $?
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

# Seed the JARVIS persona as SOUL.md — but ONLY if absent, so re-applying
# after an update never clobbers an operator's customized SOUL.md.
if [ -f "$OVERLAY_DIR/persona/JARVIS.md" ]; then
  if [ ! -f "$HERMES_HOME/SOUL.md" ]; then
    cp -f "$OVERLAY_DIR/persona/JARVIS.md" "$HERMES_HOME/SOUL.md"
    echo "  ✓ persona -> $HERMES_HOME/SOUL.md (seeded)"
  else
    echo "  · persona -> $HERMES_HOME/SOUL.md already present (left as-is)"
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
else
  echo "  · no JARVIS icon set at installer/assets/icons — shortcuts fall back to the exe icon"
fi

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
add() { [ -f "$1" ] && FILES+=("$1"); }
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
  gateway/platforms/whatsapp_common.py gateway/platforms/qqbot/adapter.py \
  gateway/run.py; do
  add "$SRC/$f"
done
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
[ ${#FILES[@]} -gt 0 ] && rewrite "${FILES[@]}"

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
    hits="$(grep -nE '\bHermes\b|NOUS HERMES|HERMES AGENT' "$f" 2>/dev/null \
            | grep -vE 'X-Hermes-|HermesCLI|updateHermes|checkHermesUpdate|can_update_hermes' || true)"
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
  "$SRC/gateway/platforms/whatsapp_common.py" "$SRC/cli.py"

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
fi

if [ "$LEAKS" -gt 0 ]; then
  echo
  echo "  ##################################################################"
  printf '  # WARNING: %-3d visible brand string(s) survived the rebrand!      #\n' "$LEAKS"
  echo "  # Review the lines above and extend branding.map, then re-apply.  #"
  echo "  ##################################################################"
  echo
else
  echo "  ✓ no visible brand strings survived across all locale + web + cli + desktop surfaces"
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
