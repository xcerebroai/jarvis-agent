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

resolve_python() {
  for c in "${HERMES_PYTHON:-}" python3 python py; do
    [ -z "$c" ] && continue
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1; then
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

SRC="$(resolve_src "${1:-}" || true)"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "ERROR: could not locate the Hermes source tree." >&2
  echo "       Pass it explicitly:  HERMES_SRC=/path/to/hermes-agent ./apply.sh" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

echo "◆ JARVIS overlay — applying"
echo "  source : $SRC"
echo "  data   : $HERMES_HOME"
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
[ ${#FILES[@]} -gt 0 ] && rewrite "${FILES[@]}"

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
    hits="$(grep -nE '\bHermes\b|\bNOUS HERMES\b' "$f" 2>/dev/null \
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

if [ "$LEAKS" -gt 0 ]; then
  echo
  echo "  ##################################################################"
  printf '  # WARNING: %-3d visible brand string(s) survived the rebrand!      #\n' "$LEAKS"
  echo "  # Review the lines above and extend branding.map, then re-apply.  #"
  echo "  ##################################################################"
  echo
else
  echo "  ✓ no visible brand strings survived across all locale + web + cli surfaces"
fi

echo "◆ JARVIS overlay — done"
