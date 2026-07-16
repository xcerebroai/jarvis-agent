#!/usr/bin/env bash
# brand-installer.sh — layer JARVIS branding onto upstream's Tauri bootstrap
# installer (hermes-agent/apps/bootstrap-installer), Tier-1 discipline:
# visible strings + art become JARVIS; functional identifiers stay untouched.
#
#   Usage:  bash installer/brand-installer.sh /path/to/hermes-agent
#
# Idempotent: re-running after a partial run repairs; running twice is a no-op
# (there is no "Hermes" left to rewrite the second time).
#
# What it does NOT touch (functional identifiers — parity with the overlay's
# branding.map and the desktop rebrand discipline):
#   • bundle identifier  com.nousresearch.hermes.setup   (OS/updater identity)
#   • Tauri command names  get_hermes_home / launch_hermes_desktop / start_*
#   • npm package  @nous-research/ui   (real dependency)
#   • HERMES_HOME / ~/.hermes / %LOCALAPPDATA%\hermes paths, the stage protocol,
#     and the pinned raw.githubusercontent NousResearch install-script source
#     (we WANT upstream's install.ps1 as the base install; JARVIS is layered on
#     top by the injected overlay stage — see installer/overlay-stage/).
#   • the desktop app's CFBundleName (branded later by the overlay stage via
#     apply.sh/branding.map): it stays "Hermes" because Electron derives the
#     macOS helper-app names from it (electron_main_delegate_mac.mm) and the
#     helpers in Contents/Frameworks are named from productName — a mismatch
#     crashes at launch ("Unable to find helper app"). Only
#     CFBundleDisplayName (Finder/dock) is rebranded to JARVIS.
#
# What it DOES rewrite:
#   • productName / window title / descriptions / publisher / copyright
#   • Cargo.toml [[bin]] name  ->  JARVIS-Setup   (the shipped artifact name)
#   • visible React/HTML brand text  Hermes|HERMES( AGENT)? -> JARVIS,
#     Nous Research -> Xcerebro, the `hermes desktop` hint -> `jarvis desktop`
#   • icons + the brand image  (nous-girl.jpg -> jarvis-mark.png)
#   • flips include_desktop:true -> false so upstream skips Stage-Desktop and
#     never creates a Hermes.lnk; the injected JARVIS overlay stage builds the
#     branded desktop and creates JARVIS shortcuts instead
#   • injects the JARVIS overlay stage (Rust glue + bundled shell scripts)
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$OVERLAY_DIR/installer/assets"

SRC="${1:-${HERMES_SRC:-}}"
[ -n "$SRC" ] || { echo "usage: brand-installer.sh /path/to/hermes-agent" >&2; exit 1; }
APP="$SRC/apps/bootstrap-installer"
[ -d "$APP" ] || { echo "ERROR: $APP not found (is this a hermes-agent checkout?)" >&2; exit 1; }

command -v perl >/dev/null 2>&1 || { echo "ERROR: perl is required for the branding rewrites." >&2; exit 1; }

say() { printf '  %s\n' "$*"; }
# In-place regex over one file (perl = portable across GNU/BSD/Git-Bash).
sub() { perl -0777 -pi -e "$1" "$2"; }

echo "◆ Branding the Tauri bootstrap installer -> JARVIS"
echo "  app: $APP"

# --- 1. tauri.conf.json — visible product identity -------------------------
TC="$APP/src-tauri/tauri.conf.json"
sub 's/"productName":\s*"Hermes"/"productName": "JARVIS"/'                         "$TC"
sub 's/"title":\s*"Hermes"/"title": "JARVIS"/'                                     "$TC"
sub 's/"shortDescription":\s*"Hermes"/"shortDescription": "JARVIS"/'               "$TC"
sub 's/"longDescription":\s*"[^"]*"/"longDescription": "Installs JARVIS \x28your AI employee\x29 on your machine."/' "$TC"
sub 's/"publisher":\s*"Nous Research"/"publisher": "Xcerebro"/'                    "$TC"
sub 's/"copyright":\s*"Copyright \S+ 2026 Nous Research"/"copyright": "Copyright \x28c\x29 2026 Xcerebro"/' "$TC"
say "tauri.conf.json: productName/title/desc/publisher/copyright -> JARVIS (identifier kept)"

# --- 2. Cargo.toml — the shipped artifact name -----------------------------
CT="$APP/src-tauri/Cargo.toml"
sub 's/name = "Hermes-Setup"/name = "JARVIS-Setup"/'                                "$CT"
sub 's/description = "Hermes Setup[^"]*"/description = "JARVIS Setup — installs JARVIS with a native UI"/' "$CT"
say "Cargo.toml: [[bin]] name -> JARVIS-Setup (crate/lib names kept)"

# --- 3. Frontend + index.html — visible brand text -------------------------
# Curated file set. We rewrite ONLY capitalised brand nouns + two explicit
# visible phrases; lowercase `hermes`/`nous` (Tauri command names, import
# specifiers, paths, CSS classes) are left alone by construction.
FILES=(
  "$APP/index.html"
  "$APP/src/app.tsx" "$APP/src/main.tsx" "$APP/src/store.ts"
  "$APP/src/routes/welcome.tsx" "$APP/src/routes/success.tsx"
  "$APP/src/routes/progress.tsx" "$APP/src/routes/failure.tsx"
  "$APP/src/components/brand-mark.tsx" "$APP/src/styles.css"
)
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  sub 's/HERMES AGENT/JARVIS/g'        "$f"   # wordmark
  sub 's/\bHermes\b/JARVIS/g'          "$f"   # brand noun (also Hermes-Setup.exe in comments)
  sub 's/\bHERMES\b/JARVIS/g'          "$f"   # uppercase wordmark
  sub 's/Nous Research/Xcerebro/g'     "$f"
  sub 's/hermes desktop/jarvis desktop/g' "$f"   # visible CLI hint (jarvis shim backs it)
  sub 's/nous-girl\.jpg/jarvis-mark.png/g' "$f"  # brand image asset
done
say "frontend + index.html: visible Hermes/HERMES/Nous Research -> JARVIS/Xcerebro"

# --- 4. No transient Hermes.lnk: upstream skips its desktop stage ----------
# include_desktop:false makes install.ps1 omit Stage-Desktop (where the ONLY
# New-DesktopShortcuts / Hermes.lnk call lives). The overlay stage builds the
# branded desktop and creates JARVIS.lnk.
sub 's/include_desktop:\s*true/include_desktop: false/' "$APP/src/store.ts"
say "store.ts: include_desktop -> false (upstream never builds desktop / Hermes.lnk)"

# --- 5. Art: icons + brand image -------------------------------------------
if [ -d "$ASSETS/icons" ] && ls "$ASSETS/icons"/*.png >/dev/null 2>&1; then
  cp -f "$ASSETS/icons/32x32.png"      "$APP/src-tauri/icons/32x32.png"
  cp -f "$ASSETS/icons/128x128.png"    "$APP/src-tauri/icons/128x128.png"
  cp -f "$ASSETS/icons/128x128@2x.png" "$APP/src-tauri/icons/128x128@2x.png"
  [ -f "$ASSETS/icons/icon.ico" ]  && cp -f "$ASSETS/icons/icon.ico"  "$APP/src-tauri/icons/icon.ico"
  [ -f "$ASSETS/icons/icon.icns" ] && cp -f "$ASSETS/icons/icon.icns" "$APP/src-tauri/icons/icon.icns"
  say "icons: replaced with JARVIS set"
else
  echo "  ⚠ no generated icons at $ASSETS/icons — run installer/gen-icons.sh first (CI does this)."
fi
if [ -f "$ASSETS/jarvis-mark.png" ]; then
  cp -f "$ASSETS/jarvis-mark.png" "$APP/public/jarvis-mark.png"
  rm -f "$APP/public/nous-girl.jpg"
  say "brand image: public/jarvis-mark.png (nous-girl.jpg removed)"
else
  echo "  ⚠ no brand image at $ASSETS/jarvis-mark.png — brand-mark will 404 until generated."
fi

# --- 6. Inject the JARVIS overlay stage (Rust glue + bundled scripts) -------
bash "$OVERLAY_DIR/installer/inject-overlay-stage.sh" "$SRC"

# --- 7. Guardrails ---------------------------------------------------------
# Never let a rewrite mangle the real npm dependency or the Tauri command names.
if ! grep -q '@nous-research/ui' "$APP/package.json"; then
  echo "ERROR: @nous-research/ui dependency was altered — aborting (functional id must be preserved)." >&2
  exit 1
fi
for cmd in get_hermes_home launch_hermes_desktop start_bootstrap; do
  grep -q "$cmd" "$APP/src/store.ts" || { echo "ERROR: Tauri command '$cmd' lost in rewrite." >&2; exit 1; }
done
# Bundle identifier must remain the functional upstream id.
grep -q '"identifier": "com.nousresearch.hermes.setup"' "$TC" || {
  echo "ERROR: bundle identifier changed — must stay com.nousresearch.hermes.setup." >&2; exit 1; }

# (#11) The two rewrites that MUST have taken — a silent perl no-op after an
# upstream reformat would otherwise ship the exact regressions this transform
# exists to prevent, with green CI.
grep -q 'include_desktop: false' "$APP/src/store.ts" || {
  echo "ERROR: include_desktop flip did not take — upstream Stage-Desktop would run and create Hermes.lnk." >&2; exit 1; }
grep -q 'name = "JARVIS-Setup"' "$APP/src-tauri/Cargo.toml" || {
  echo "ERROR: [[bin]] rename to JARVIS-Setup did not take." >&2; exit 1; }

# (#11) Debrand verify: no visible capitalized brand may survive the rewrite.
LEFT="$(grep -rnE '\bHermes\b|HERMES AGENT|\bHERMES\b|Nous Research' "$APP/src" "$APP/index.html" 2>/dev/null || true)"
if [ -n "$LEFT" ]; then
  echo "ERROR: visible brand strings survived the installer rebrand:" >&2
  printf '%s\n' "$LEFT" | head -10 >&2
  exit 1
fi
echo "  ✓ guardrails: flip taken, bin renamed, no visible brand strings survive"

echo "◆ JARVIS installer branding applied."
