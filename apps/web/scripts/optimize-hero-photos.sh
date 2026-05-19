#!/usr/bin/env bash
# Optimize a directory of source photos into the hero slideshow asset set.
#
# Usage:   bash apps/web/scripts/optimize-hero-photos.sh <input-dir>
# Output:  apps/web/public/hero/NNN.jpg, NNN.webp, manifest.json
#
# Re-running clears the existing hero directory and regenerates everything
# from scratch so the output is deterministic for any given input set.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <input-dir>" >&2
  exit 64
fi

input_dir="$1"

if [[ ! -d "$input_dir" ]]; then
  echo "Error: input directory not found: $input_dir" >&2
  exit 66
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir="$script_dir/../public/hero"

if ! command -v magick >/dev/null 2>&1; then
  echo "Error: ImageMagick 'magick' not found in PATH." >&2
  echo "Install with: brew install imagemagick webp" >&2
  exit 69
fi

mkdir -p "$output_dir"

find "$output_dir" -maxdepth 1 -type f \
  \( -name '*.jpg' -o -name '*.webp' -o -name 'manifest.json' \) -delete

inputs=()
while IFS= read -r -d '' path; do
  inputs+=("$path")
done < <(find "$input_dir" -maxdepth 1 -type f \
  \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print0 | sort -z)

if [[ ${#inputs[@]} -eq 0 ]]; then
  echo "Error: no .jpg/.jpeg/.png files found in $input_dir" >&2
  exit 65
fi

echo "Optimizing ${#inputs[@]} photo(s) → $output_dir"

manifest_tmp="$output_dir/manifest.json.tmp"
: > "$manifest_tmp"
printf '[\n' >> "$manifest_tmp"

i=0
last_idx=$((${#inputs[@]} - 1))
for src in "${inputs[@]}"; do
  num=$(printf '%03d' "$((i + 1))")
  jpg_out="$output_dir/$num.jpg"
  webp_out="$output_dir/$num.webp"

  magick "$src" \
    -auto-orient \
    -resize '1920x1280^' \
    -gravity Center -extent '1920x1280' \
    -strip \
    -interlace JPEG \
    -sampling-factor 4:2:0 \
    -quality 82 \
    "$jpg_out"

  magick "$jpg_out" \
    -define webp:method=6 \
    -quality 80 \
    "$webp_out"

  jpg_kb=$(( $(wc -c < "$jpg_out") / 1024 ))
  webp_kb=$(( $(wc -c < "$webp_out") / 1024 ))
  printf '  %s — jpg %dKB · webp %dKB\n' "$num" "$jpg_kb" "$webp_kb"

  if [[ $i -eq $last_idx ]]; then
    printf '  {"jpg":"/hero/%s.jpg","webp":"/hero/%s.webp"}\n' "$num" "$num" >> "$manifest_tmp"
  else
    printf '  {"jpg":"/hero/%s.jpg","webp":"/hero/%s.webp"},\n' "$num" "$num" >> "$manifest_tmp"
  fi

  i=$((i + 1))
done

printf ']\n' >> "$manifest_tmp"
mv "$manifest_tmp" "$output_dir/manifest.json"

echo "Wrote $output_dir/manifest.json (${#inputs[@]} entries)"
