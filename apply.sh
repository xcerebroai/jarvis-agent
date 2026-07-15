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

# Verify the BUILT desktop renderer bundle (apps/desktop/dist) — visible brand
# leaks and JARVIS wordmark presence. Called after an Electron rebuild.
verify_desktop_build() {
  local src="$1"
  local dist="$src/apps/desktop/dist"
  echo "◆ JARVIS desktop — verify built renderer bundle"
  if [ ! -d "$dist" ]; then
    echo "  · no built bundle at apps/desktop/dist — desktop not built here (skipping)"
    return 0
  fi
  local phrase_hits wordmark rc=0
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
  if [ "$rc" -eq 0 ]; then
    echo "  ✓ no visible Hermes brand phrases survived in the built desktop bundle"
  else
    echo
    echo "  ##################################################################"
    echo "  # WARNING: desktop build carries un-rebranded brand strings!      #"
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

echo "◆ JARVIS overlay — applying"
echo "  source : $SRC"
echo "  data   : $HERMES_HOME"

# (#13) The skin/config in $HERMES_HOME are PER-USER and shared by every
# Hermes install on this machine — activating the JARVIS skin rebrands the
# CLI of all of them (the runtime reads exactly one home). Warn loudly when
# another hermes-agent tree exists so this is never a surprise.
for _other in "${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/hermes-agent" \
              "$HOME/.hermes/hermes-agent" "$HOME/jarvis/hermes-agent"; do
  [ -d "$_other/.git" ] || continue
  [ "$(cd "$_other" 2>/dev/null && pwd)" = "$SRC" ] && continue
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
# Two jobs:
#   a) Swap the desktop app's icon sources at apps/desktop/assets/icon.* —
#      the ONE point everything downstream reads: electron-builder's bundle
#      icon ("icon": "assets/icon"), the rcedit exe stamp
#      (scripts/set-exe-identity.mjs uses assets/icon.ico), and the runtime
#      dock icon. Rebuilt desktops then carry JARVIS art on every platform.
#      Recorded in the manifest (section 3) so updates revert them pre-pull.
#   b) Stage stable copies under $HERMES_HOME/.jarvis/ for shortcuts to
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
MANIFEST="$MANIFEST_DIR/branded-files.txt"
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
              apps/desktop/assets/icon.png; do
  [ -f "$SRC/$_asset" ] || continue
  is_excluded "$_asset" && continue
  # Only tracked files: the Setup path reverts the manifest in ONE batched
  # `git checkout -- <paths>`, which fails wholesale on an untracked pathspec.
  git -C "$SRC" ls-files --error-unmatch "$_asset" >/dev/null 2>&1 || continue
  echo "$_asset" >> "$MANIFEST"
done
[ ${#FILES[@]} -gt 0 ] && rewrite "${FILES[@]}"

# --- 3b. Desktop build-config — surgical, key-anchored [desktop] literals ---
# Applied ONLY to package.json + electron/main.ts. Each pattern includes its
# JSON key / code context so it rebrands the visible app name (CFBundle*Name,
# dmg title, permission text, app.setName default) without ever matching the
# protected productName/executableName/CFBundleExecutable/appId on adjacent
# lines. Independent JSON validity is asserted after the edit.
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
# break Hermes's own updater, which hardcodes Hermes.app/Hermes.exe).
DESK_PKG="$SRC/apps/desktop/package.json"
if [ -f "$DESK_PKG" ]; then
  cfg_bad() { echo "  ⚠ [desktop-config] $1"; LEAKS=$((LEAKS + 1)); }
  grep -q '"CFBundleDisplayName": "JARVIS"' "$DESK_PKG" || cfg_bad "CFBundleDisplayName not rebranded to JARVIS"
  grep -q '"CFBundleName": "JARVIS"'        "$DESK_PKG" || cfg_bad "CFBundleName not rebranded to JARVIS"
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

echo "◆ JARVIS overlay — done"
