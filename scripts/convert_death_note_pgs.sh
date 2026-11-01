#!/bin/bash
set -u

source_dir='/Volumes/T7/Anime/Death Note (2006)'
output_dir="$source_dir/Sous-titres FR SRT"
work_dir=$(mktemp -d /private/tmp/iptv-pgs-death-note.XXXXXX)

mkdir -p "$output_dir"
find "$source_dir" -maxdepth 1 -type f -name '*.mkv' -print0 | sort -z |
while IFS= read -r -d '' episode; do
  stem=$(basename "${episode%.mkv}")
  output="$output_dir/$stem.fr.srt"
  temp_sup="$work_dir/$stem.sup"
  if [ -f "$output" ]; then
    echo "SKIP $stem"
    continue
  fi
  echo "START $stem"
  if ffmpeg -v error -y -i "$episode" -map 0:3 -c:s copy "$temp_sup" \
    && /private/tmp/iptv-pgs-ocr "$temp_sup" "$output"; then
    rm -f "$temp_sup"
    echo "DONE $stem"
  else
    rm -f "$temp_sup" "$output"
    echo "FAIL $stem"
  fi
done
rmdir "$work_dir" 2>/dev/null || true
echo COMPLETE
