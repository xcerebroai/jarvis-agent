#!/usr/bin/env bash
# install-jarvis.sh — JARVIS-branded installer that wraps Hermes's setup.
#
# Flow:
#   1. Show the JARVIS banner (UTF-8 with automatic ASCII/color fallbacks).
#   2. Run the real setup-hermes.sh (unmodified) to install Hermes.
#   3. Install the `jarvis` command shim onto PATH.
#   4. Run apply.sh to brand the fresh install (skin + string rewrites).
#   5. Print branded next steps.
#
# The underlying Hermes install is left pristine; all branding is layered on
# top so `hermes update` (via update-jarvis.sh) always pulls clean upstream.
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

resolve_python() {
  for c in "${HERMES_PYTHON:-}" python3 python py; do
    [ -z "$c" ] && continue
    command -v "$c" >/dev/null 2>&1 && "$c" -c 'import yaml' >/dev/null 2>&1 && { echo "$c"; return 0; }
  done
  return 1
}

# --- Resolve the Hermes source tree ---------------------------------------
# $HERMES_SRC -> $1 -> a sibling/cwd hermes-agent checkout containing setup.
resolve_src() {
  if [ -n "${HERMES_SRC:-}" ]; then echo "$HERMES_SRC"; return 0; fi
  if [ -n "${1:-}" ]; then echo "$1"; return 0; fi
  local d
  for d in "$PWD" "$PWD/hermes-agent" "$OVERLAY_DIR/../hermes-agent" "$OVERLAY_DIR/../../hermes-agent"; do
    [ -f "$d/setup-hermes.sh" ] && { (cd "$d" && pwd); return 0; }
  done
  return 1
}

SRC="$(resolve_src "${1:-}" || true)"
if [ -z "$SRC" ] || [ ! -f "$SRC/setup-hermes.sh" ]; then
  echo "ERROR: could not find hermes-agent/setup-hermes.sh." >&2
  echo "       Clone https://github.com/NousResearch/hermes-agent first, then:" >&2
  echo "       HERMES_SRC=/path/to/hermes-agent ./install-jarvis.sh" >&2
  exit 1
fi
SRC="$(cd "$SRC" && pwd)"

# --- 1. Branded banner -----------------------------------------------------
if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  PYB="$(command -v python3 || command -v python)"
  "$PYB" "$OVERLAY_DIR/bin/jarvis-banner" || true
fi
echo "  Installing JARVIS — your AI employee. Wrapping Hermes Agent setup…"
echo

# --- Windows / Git Bash compatibility for upstream setup-hermes.sh ---------
# setup-hermes.sh assumes a Unix venv layout (venv/bin/{python,hermes}) and
# symlinks hermes into ~/.local/bin. On Windows the venv is venv/Scripts/*.exe,
# so those paths are missing and `ln -s` (which Git Bash resolves by COPYING
# the source) fails with ENOENT. We satisfy the upstream assumption WITHOUT
# patching it: create Unix-layout shim files under venv/bin that forward to the
# real venv/Scripts/*.exe, then let setup-hermes.sh run unmodified.
is_win_bash() {
  case "${OS:-}${OSTYPE:-}$(uname -s 2>/dev/null)" in
    *Windows_NT*|*msys*|*cygwin*|*MINGW*|*MSYS*) return 0 ;; *) return 1 ;;
  esac
}
ensure_local_bin() {
  mkdir -p "$HOME/.local/bin"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
}
# Create venv/bin/<name> -> venv/Scripts/<exe> forwarders (absolute path, so the
# shim keeps working after setup-hermes.sh copies it into ~/.local/bin).
make_venv_shims() {
  local src="$1" b="$1/venv/bin" s="$1/venv/Scripts" name exe pair
  [ -d "$s" ] || return 1
  mkdir -p "$b"
  for pair in python:python.exe python3:python.exe pip:pip.exe pip3:pip.exe \
              hermes:hermes.exe hermes-agent:hermes-agent.exe hermes-acp:hermes-acp.exe; do
    name="${pair%%:*}"; exe="${pair##*:}"
    [ -f "$s/$exe" ] || continue
    printf '#!/bin/sh\nexec "%s/%s" "$@"\n' "$s" "$exe" > "$b/$name"
    chmod +x "$b/$name" 2>/dev/null || true
  done
}
# Run setup-hermes.sh once. In a real terminal (tty), its prompts work
# normally; when driven non-interactively (CI / a GUI installer), decline the
# optional prompts (ripgrep, the setup wizard) so it can't hang — the user
# configures on first launch instead of a terminal wizard. Those prompts use
# `read -n 1`, which consumes one char each, so we feed bare 'n's (no newlines).
run_setup_once() {
  if [ -t 0 ]; then
    ( cd "$SRC" && bash ./setup-hermes.sh "$@" )
  else
    ( cd "$SRC" && printf 'nnnnnnnn' | bash ./setup-hermes.sh "$@" )
  fi
}
# On Windows, repair the venv/bin layout and retry once so a partial install
# (venv already built) completes instead of failing. Idempotent.
run_hermes_setup() {
  ensure_local_bin
  if is_win_bash && [ -f "$SRC/venv/Scripts/hermes.exe" ]; then
    echo "  (Windows) creating venv/bin compatibility shims…"
    make_venv_shims "$SRC"
  fi
  if run_setup_once "$@"; then return 0; fi
  if is_win_bash && [ -f "$SRC/venv/Scripts/hermes.exe" ]; then
    echo "  (Windows) setup hit a Unix-only step; applying venv/bin shims and retrying…"
    make_venv_shims "$SRC"
    run_setup_once "$@" || return 1
    return 0
  fi
  return 1
}

# --- 2. Run the real Hermes setup (unmodified, with Windows repair) ---------
echo "◆ Running Hermes setup (setup-hermes.sh)…"
run_hermes_setup "${@:2}"

# --- 3. Install the `jarvis` shim onto PATH --------------------------------
BIN_DIR="${JARVIS_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
cp -f "$OVERLAY_DIR/bin/jarvis" "$BIN_DIR/jarvis"
chmod +x "$BIN_DIR/jarvis" 2>/dev/null || true
cp -f "$OVERLAY_DIR/bin/jarvis-banner" "$BIN_DIR/jarvis-banner"
chmod +x "$BIN_DIR/jarvis-banner" 2>/dev/null || true
if is_win_bash; then
  cp -f "$OVERLAY_DIR/bin/jarvis.cmd" "$BIN_DIR/jarvis.cmd"
  # Cross-shell `hermes` for PowerShell/cmd (Git Bash gets the shim from setup).
  if [ -f "$SRC/venv/Scripts/hermes.exe" ]; then
    HEXE_WIN="$(cygpath -w "$SRC/venv/Scripts/hermes.exe" 2>/dev/null || echo "$SRC/venv/Scripts/hermes.exe")"
    printf '@echo off\r\n"%s" %%*\r\n' "$HEXE_WIN" > "$BIN_DIR/hermes.cmd"
  fi
fi
echo "◆ installed 'jarvis' command -> $BIN_DIR/jarvis"

# --- 4. Apply JARVIS branding ---------------------------------------------
echo "◆ Applying JARVIS branding…"
HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh"

# --- 4b. Build the JARVIS desktop app (in scope by default) ---------------
RUNTIME="$(command -v jarvis 2>/dev/null || command -v hermes 2>/dev/null || echo "$BIN_DIR/jarvis")"

# Locate the built, launchable executable for the current platform.
find_desktop_exe() {
  local rel="$SRC/apps/desktop/release"
  local c
  for c in \
    "$rel"/mac*/Hermes.app \
    "$rel/win-unpacked/Hermes.exe" "$rel/win-ia32-unpacked/Hermes.exe" "$rel/win-arm64-unpacked/Hermes.exe" \
    "$rel/linux-unpacked/hermes" "$rel/linux-unpacked/Hermes" "$rel/linux-arm64-unpacked/Hermes"; do
    [ -e "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

build_desktop() {
  if [ -n "${JARVIS_SKIP_DESKTOP:-}" ]; then
    echo "◆ Skipping desktop build (JARVIS_SKIP_DESKTOP set)."
    return 1
  fi
  echo "◆ Building the JARVIS desktop app…"
  if ! command -v node >/dev/null 2>&1; then
    echo "  ⚠ Node.js not found. The desktop app needs Node ^20.19 || >=22.12."
    echo "    Install Node, then run:  $RUNTIME desktop --build-only"
    return 1
  fi
  local nodev major
  nodev="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${nodev%%.*}"
  if [ "${major:-0}" -lt 20 ]; then
    echo "  ⚠ Node $nodev is too old (need ^20.19 || >=22.12). Upgrade, then run:"
    echo "      $RUNTIME desktop --build-only"
    return 1
  fi
  echo "  Node v$nodev detected. First build downloads Electron + deps —"
  echo "  this takes a few minutes; don't close."
  if "$RUNTIME" desktop --build-only; then
    echo "  ✓ JARVIS desktop built"
    HERMES_SRC="$SRC" bash "$OVERLAY_DIR/apply.sh" --verify-build "$SRC" || \
      echo "  ⚠ built bundle carries brand strings — see warning above"
    return 0
  fi
  echo "  ⚠ desktop build failed — retry later with:  $RUNTIME desktop --build-only"
  return 1
}

# Create JARVIS-named launch points so clients never launch via a Hermes path.
create_launch_points() {
  local exe; exe="$(find_desktop_exe || true)"
  [ -z "$exe" ] && { echo "  · no built desktop executable found — skipping launch points"; return 0; }
  case "${OS:-}${OSTYPE:-}$(uname -s 2>/dev/null)" in
    *Windows_NT*|*msys*|*cygwin*|*win32*|*MINGW*)
      local exe_w dir_w start desk
      exe_w="$(cygpath -w "$exe" 2>/dev/null || echo "$exe")"
      dir_w="$(cygpath -w "$(dirname "$exe")" 2>/dev/null || dirname "$exe")"
      start="${JARVIS_SHORTCUT_DIR:-$APPDATA/Microsoft/Windows/Start Menu/Programs}"
      desk="${JARVIS_DESKTOP_DIR:-$USERPROFILE/Desktop}"
      mkdir -p "$start" "$desk" 2>/dev/null || true
      for loc in "$start/JARVIS.lnk" "$desk/JARVIS.lnk"; do
        local loc_w; loc_w="$(cygpath -w "$loc" 2>/dev/null || echo "$loc")"
        powershell.exe -NoProfile -NonInteractive -Command \
          "\$s=(New-Object -ComObject WScript.Shell).CreateShortcut('$loc_w'); \$s.TargetPath='$exe_w'; \$s.WorkingDirectory='$dir_w'; \$s.IconLocation='$exe_w,0'; \$s.Description='JARVIS'; \$s.Save()" \
          >/dev/null 2>&1 \
          && echo "  ✓ JARVIS shortcut -> ${loc}" \
          || echo "  ⚠ could not create shortcut at ${loc}"
      done
      ;;
    *Darwin*)
      # The bundle is Hermes.app but CFBundleDisplayName=JARVIS, so Finder/dock
      # show "JARVIS". Symlink it into /Applications (or ~/Applications) so it's
      # launchable; the display name comes from the bundle, not the link name.
      local appdir="/Applications"; [ -w "$appdir" ] || appdir="$HOME/Applications"
      mkdir -p "$appdir" 2>/dev/null || true
      ln -sfn "$exe" "$appdir/JARVIS.app" 2>/dev/null \
        && echo "  ✓ JARVIS.app -> $appdir/JARVIS.app (Finder/dock show JARVIS via CFBundleDisplayName)" \
        || echo "  ⚠ could not link JARVIS.app into $appdir"
      ;;
    *Linux*)
      local appdir="${JARVIS_SHORTCUT_DIR:-$HOME/.local/share/applications}"
      mkdir -p "$appdir"
      cat > "$appdir/jarvis.desktop" <<DESKTOP
[Desktop Entry]
Name=JARVIS
Comment=Your AI Employee
Exec=$exe
Terminal=false
Type=Application
Categories=Development;Utility;
DESKTOP
      echo "  ✓ JARVIS launcher -> $appdir/jarvis.desktop"
      ;;
    *)
      echo "  · unknown platform — skipping launch points" ;;
  esac
}

if build_desktop; then
  create_launch_points
fi

# --- 5. Branded next steps -------------------------------------------------
cat <<'EOF'

◆ JARVIS is ready — all three surfaces branded.
    jarvis                 # terminal / PowerShell CLI
    JARVIS (Start Menu / dock / launcher)   # desktop app
    jarvis gateway         # messaging gateway; dashboard at the printed URL
    jarvis status          # check configuration
    ./update-jarvis.sh     # update upstream + re-apply branding + rebuild desktop

  Note: `jarvis` and `hermes` are the same runtime; your data stays in
  ~/.hermes (paths are intentionally left as-is so the tooling keeps working).
  The desktop app's window/dock/menu read JARVIS; its bundle/exe filename
  stays "Hermes" internally so the self-updater keeps working.
EOF
