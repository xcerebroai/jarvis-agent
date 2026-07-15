#!/usr/bin/env bash
# gen-icons.sh — rasterize the JARVIS logo/mark SVGs into the icon set the
# Tauri installer bundles. Run in CI (needs a rasterizer + ImageMagick, and
# ideally icnsutils for a proper multi-size .icns):
#   ubuntu:  apt-get install -y imagemagick librsvg2-bin icnsutils
#
# Outputs (consumed by installer/brand-installer.sh):
#   assets/icons/{32x32.png,128x128.png,128x128@2x.png,icon.ico,icon.icns}
#   assets/jarvis-mark.png
#
# Swap assets/jarvis-logo.svg + jarvis-mark.svg for final art and re-run —
# nothing downstream changes.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$DIR/assets"; ICONS="$ASSETS/icons"
LOGO="$ASSETS/jarvis-logo.svg"; MARK="$ASSETS/jarvis-mark.svg"
mkdir -p "$ICONS"

have() { command -v "$1" >/dev/null 2>&1; }
IM=""; have magick && IM=magick; [ -z "$IM" ] && have convert && IM=convert

# rasterize <svg> <size> <out.png>
rasterize() {
  local svg="$1" size="$2" out="$3"
  if   have rsvg-convert; then rsvg-convert -w "$size" -h "$size" "$svg" -o "$out"
  elif have inkscape;     then inkscape "$svg" --export-type=png --export-filename="$out" -w "$size" -h "$size" >/dev/null 2>&1
  elif [ -n "$IM" ];      then "$IM" -background none -density 512 "$svg" -resize "${size}x${size}" "$out"
  else echo "ERROR: need rsvg-convert, inkscape, or ImageMagick to rasterize SVG." >&2; exit 1
  fi
}

echo "◆ Generating JARVIS icons from $LOGO"
rasterize "$LOGO" 32  "$ICONS/32x32.png"
rasterize "$LOGO" 128 "$ICONS/128x128.png"
rasterize "$LOGO" 256 "$ICONS/128x128@2x.png"
# (#23) apply.sh swaps this over apps/desktop/assets/icon.png (Electron's
# linux/window icon source) — keep it high-res.
rasterize "$LOGO" 512 "$ICONS/icon-512.png"

tmp="$(mktemp -d)"
for s in 16 24 32 48 64 128 256 512 1024; do rasterize "$LOGO" "$s" "$tmp/i$s.png"; done

# --- .ico (multi-resolution) — ImageMagick ---
[ -n "$IM" ] || { echo "ERROR: ImageMagick required for icon.ico." >&2; exit 1; }
"$IM" "$tmp"/i16.png "$tmp"/i24.png "$tmp"/i32.png "$tmp"/i48.png "$tmp"/i64.png "$tmp"/i128.png "$tmp"/i256.png "$ICONS/icon.ico"

# --- .icns — prefer png2icns (proper multi-size), else ImageMagick ---
if have png2icns; then
  png2icns "$ICONS/icon.icns" "$tmp"/i16.png "$tmp"/i32.png "$tmp"/i48.png "$tmp"/i128.png "$tmp"/i256.png "$tmp"/i512.png "$tmp"/i1024.png
else
  "$IM" "$tmp/i1024.png" "$ICONS/icon.icns"
fi

# --- in-app brand image (diamond on transparent) ---
rasterize "$MARK" 256 "$ASSETS/jarvis-mark.png"

rm -rf "$tmp"
echo "  ✓ icons -> $ICONS"
ls -la "$ICONS" "$ASSETS/jarvis-mark.png"
