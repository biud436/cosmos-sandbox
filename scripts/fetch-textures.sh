#!/usr/bin/env bash
# Fetch photoreal planet textures for the 정밀 행성 관측 모드 (planet mode).
#
# Source: Solar System Scope (https://www.solarsystemscope.com/textures/),
# released under CC-BY-4.0 — real satellite-derived equirectangular maps, far
# more accurate and self-consistent than AI-generated planets.
#
# Layout:
#   public/textures/earth/  — Earth's multi-map set (day/night/clouds/…)
#   public/textures/solar/  — every other solar-system body, single base map
#   public/textures/env/    — Milky Way background, Moon
#
# Earth/Mars keep an 8K hero original (gitignored, *_8k.*) + a committed 4K
# base. The other bodies commit a single base downscaled to ≤4096 wide.
# Rocky worlds (Mercury/Moon/Mars) also get an albedo-derived bump map so the
# terminator shows relief instead of a flat sticker. Re-runnable (FORCE=1 to
# refetch). Requires: curl, ImageMagick.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="https://www.solarsystemscope.com/textures/download"
EARTH="$ROOT/public/textures/earth"
SOLAR="$ROOT/public/textures/solar"
ENV="$ROOT/public/textures/env"
mkdir -p "$EARTH" "$SOLAR" "$ENV"

if command -v magick >/dev/null 2>&1; then IM="magick"
elif command -v convert >/dev/null 2>&1; then IM="convert"
else echo "ERROR: ImageMagick (magick/convert) not found." >&2; exit 1; fi

dl() { # dl <remote-filename> <out-path>
  local remote="$1" out="$2"
  if [[ -f "$out" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$out")"; return 0; fi
  echo "  get   $remote"
  if curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$BASE/$remote"; then return 0; fi
  echo "  WARN  $remote failed" >&2; rm -f "$out"; return 1
}

resize() { # resize <src> <dst> <WxH>
  [[ -f "$1" ]] || return 1
  if [[ -f "$2" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$2")"; return 0; fi
  echo "  scale $(basename "$2")"; $IM "$1" -resize "$3" "$2"
}

tif2png() { # tif2png <remote-tif> <out-8k> <out-4k>
  local remote="$1" out8="$2" out4="$3" tmp; tmp="$(mktemp -t tex).tif"
  if [[ -f "$out8" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$out8")"
  elif curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$BASE/$remote"; then
    echo "  conv  $(basename "$out8")"; $IM "$tmp" "$out8"
  else echo "  WARN  $remote failed" >&2; fi
  rm -f "$tmp"; resize "$out8" "$out4" 4096x2048
}

# getbody <sss-slug> <out-path> [ext] — try 8k→4k→2k, commit base ≤4096 wide.
getbody() {
  local slug="$1" out="$2" ext="${3:-jpg}" res tmp
  if [[ -f "$out" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$out")"; return 0; fi
  tmp="$(mktemp -t body).$ext"
  for res in 8k 4k 2k; do
    echo "  try   ${res}_${slug}.${ext}"
    if curl -fsSL --retry 2 --retry-delay 1 -o "$tmp" "$BASE/${res}_${slug}.${ext}"; then
      local w; w=$($IM identify -format '%w' "$tmp" 2>/dev/null || echo 0)
      if [[ "$w" -gt 4096 ]]; then $IM "$tmp" -resize 4096x "$out"; else cp "$tmp" "$out"; fi
      rm -f "$tmp"; echo "  ok    $(basename "$out") (${w}px → committed)"; return 0
    fi
  done
  rm -f "$tmp"; echo "  WARN  no texture for $slug" >&2; return 1
}

# bumpfrom <color> <out-bump> — albedo-derived grayscale bump for rocky worlds.
# Not geologically exact (albedo ≠ elevation), but gives the terminator real
# relief. Real MOLA/LOLA elevation is a later upgrade (see codex prompts md).
bumpfrom() {
  [[ -f "$1" ]] || return 1
  if [[ -f "$2" && "${FORCE:-0}" != "1" ]]; then echo "  skip  $(basename "$2")"; return 0; fi
  echo "  bump  $(basename "$2")"
  $IM "$1" -colorspace Gray -contrast-stretch 1%x1% -blur 0x1.1 -resize 4096x "$2"
}

echo "== Earth (multi-map) =="
dl 8k_earth_daymap.jpg   "$EARTH/earth_day_8k.jpg";    resize "$EARTH/earth_day_8k.jpg"    "$EARTH/earth_day_4k.jpg" 4096x2048
dl 8k_earth_nightmap.jpg "$EARTH/earth_night_8k.jpg";  resize "$EARTH/earth_night_8k.jpg"  "$EARTH/earth_night_4k.jpg" 4096x2048
dl 8k_earth_clouds.jpg   "$EARTH/earth_clouds_8k.jpg"; resize "$EARTH/earth_clouds_8k.jpg" "$EARTH/earth_clouds_4k.jpg" 4096x2048
tif2png 8k_earth_specular_map.tif "$EARTH/earth_ocean_mask_8k.png" "$EARTH/earth_ocean_mask_4k.png"
tif2png 8k_earth_normal_map.tif   "$EARTH/earth_normal_8k.png"     "$EARTH/earth_normal_4k.png"
if [[ -f "$EARTH/earth_ocean_mask_8k.png" ]]; then
  [[ -f "$EARTH/earth_roughness_8k.png" && "${FORCE:-0}" != "1" ]] || \
    { echo "  deriv earth_roughness_8k.png"; $IM "$EARTH/earth_ocean_mask_8k.png" -negate +level 22%,95% "$EARTH/earth_roughness_8k.png"; }
  resize "$EARTH/earth_roughness_8k.png" "$EARTH/earth_roughness_4k.png" 4096x2048
fi

echo "== Mars (color + albedo bump) =="
dl 8k_mars.jpg "$ROOT/public/textures/mars/mars_color_8k.jpg"
mkdir -p "$ROOT/public/textures/mars"
resize "$ROOT/public/textures/mars/mars_color_8k.jpg" "$ROOT/public/textures/mars/mars_color_4k.jpg" 4096x2048
bumpfrom "$ROOT/public/textures/mars/mars_color_4k.jpg" "$ROOT/public/textures/mars/mars_bump_4k.jpg"

echo "== Solar system bodies =="
getbody sun             "$SOLAR/sun.jpg"
getbody mercury         "$SOLAR/mercury.jpg";          bumpfrom "$SOLAR/mercury.jpg" "$SOLAR/mercury_bump.jpg"
getbody venus_atmosphere "$SOLAR/venus.jpg"
getbody jupiter         "$SOLAR/jupiter.jpg"
getbody saturn          "$SOLAR/saturn.jpg"
getbody saturn_ring_alpha "$SOLAR/saturn_ring.png" png
getbody uranus          "$SOLAR/uranus.jpg"
getbody neptune         "$SOLAR/neptune.jpg"

echo "== Environment =="
dl 8k_stars_milky_way.jpg "$ENV/milkyway_bg_8k.jpg"; resize "$ENV/milkyway_bg_8k.jpg" "$ENV/milkyway_bg_4k.jpg" 4096x2048
dl 8k_moon.jpg            "$ENV/moon_color_8k.jpg";  resize "$ENV/moon_color_8k.jpg"  "$ENV/moon_color_4k.jpg" 4096x2048
bumpfrom "$ENV/moon_color_4k.jpg" "$ENV/moon_bump_4k.jpg"

echo "== Done. Files in public/textures/ =="
