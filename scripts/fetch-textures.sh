#!/usr/bin/env bash
# Fetch photoreal planet textures for the "정밀 행성 관측 모드" (planet mode).
#
# Source: Solar System Scope (https://www.solarsystemscope.com/textures/),
# released under CC-BY-4.0. These are real satellite-derived equirectangular
# maps — far more accurate and self-consistent than AI-generated planets, so
# we download them directly rather than going through Codex.
#
# Produces, per body, an 8K original + a 4K downscale (the in-app base). The
# .tif data maps (normal, specular) are converted to .png. Re-runnable: it
# skips files that already exist unless FORCE=1.
#
#   bash scripts/fetch-textures.sh          # download missing
#   FORCE=1 bash scripts/fetch-textures.sh  # re-download everything
#
# Requires: curl, ImageMagick (magick or convert).

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="https://www.solarsystemscope.com/textures/download"
EARTH="$ROOT/public/textures/earth"
MARS="$ROOT/public/textures/mars"
ENV="$ROOT/public/textures/env"
mkdir -p "$EARTH" "$MARS" "$ENV"

if command -v magick >/dev/null 2>&1; then IM="magick"
elif command -v convert >/dev/null 2>&1; then IM="convert"
else echo "ERROR: ImageMagick (magick/convert) not found." >&2; exit 1; fi

dl() { # dl <remote-filename> <out-path>  — try 8k then 2k fallback
  local remote="$1" out="$2"
  if [[ -f "$out" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$out") (exists)"; return 0; fi
  echo "  get   $remote"
  if curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$BASE/$remote"; then return 0; fi
  echo "  WARN  $remote failed to download" >&2; rm -f "$out"; return 1
}

resize4k() { # resize4k <src> <dst-4k> — equirectangular 4096x2048
  [[ -f "$1" ]] || return 1
  if [[ -f "$2" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$2") (exists)"; return 0; fi
  echo "  scale $(basename "$2")"
  $IM "$1" -resize 4096x2048 "$2"
}

tif2png() { # tif2png <remote-tif> <out-png-8k> <out-png-4k>
  local remote="$1" out8="$2" out4="$3" tmp
  tmp="$(mktemp -t tex).tif"
  if [[ -f "$out8" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$out8") (exists)";
  else
    echo "  get   $remote"
    if curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$BASE/$remote"; then
      echo "  conv  $(basename "$out8")"; $IM "$tmp" "$out8"
    else echo "  WARN  $remote failed" >&2; fi
  fi
  rm -f "$tmp"
  resize4k "$out8" "$out4"
}

echo "== Earth =="
dl 8k_earth_daymap.jpg   "$EARTH/earth_day_8k.jpg";    resize4k "$EARTH/earth_day_8k.jpg"    "$EARTH/earth_day_4k.jpg"
dl 8k_earth_nightmap.jpg "$EARTH/earth_night_8k.jpg";  resize4k "$EARTH/earth_night_8k.jpg"  "$EARTH/earth_night_4k.jpg"
dl 8k_earth_clouds.jpg   "$EARTH/earth_clouds_8k.jpg"; resize4k "$EARTH/earth_clouds_8k.jpg" "$EARTH/earth_clouds_4k.jpg"
tif2png 8k_earth_specular_map.tif "$EARTH/earth_ocean_mask_8k.png" "$EARTH/earth_ocean_mask_4k.png"
tif2png 8k_earth_normal_map.tif   "$EARTH/earth_normal_8k.png"     "$EARTH/earth_normal_4k.png"

# Derive a roughness map from the ocean/specular mask: ocean (white in the
# source) should be glossy (low roughness), land matte (high). Negate so land
# is bright, then squeeze the range so ocean ≈ 0.22 and land ≈ 0.95 roughness.
if [[ -f "$EARTH/earth_ocean_mask_8k.png" ]]; then
  if [[ ! -f "$EARTH/earth_roughness_8k.png" || "${FORCE:-0}" == "1" ]]; then
    echo "  deriv earth_roughness_8k.png"
    $IM "$EARTH/earth_ocean_mask_8k.png" -negate +level 22%,95% "$EARTH/earth_roughness_8k.png"
  fi
  resize4k "$EARTH/earth_roughness_8k.png" "$EARTH/earth_roughness_4k.png"
fi

echo "== Mars =="
# Solar System Scope ships a single Mars albedo map (no normal/height). Mars
# relief (normal/height from MOLA) is a later add — see codex prompts md.
dl 8k_mars.jpg "$MARS/mars_color_8k.jpg"; resize4k "$MARS/mars_color_8k.jpg" "$MARS/mars_color_4k.jpg"

echo "== Environment (optional ambiance) =="
dl 8k_stars_milky_way.jpg "$ENV/milkyway_bg_8k.jpg"; resize4k "$ENV/milkyway_bg_8k.jpg" "$ENV/milkyway_bg_4k.jpg"
dl 8k_moon.jpg            "$ENV/moon_color_8k.jpg";  resize4k "$ENV/moon_color_8k.jpg"  "$ENV/moon_color_4k.jpg"

echo "== Done. Files in public/textures/ =="
