#!/bin/bash
set -euo pipefail

# Extract the French PGS track selected from metadata, then turn it into a
# direct-playable SRT.  The source MKV is always opened read-only.
input=$1
output=$2
ocr='/private/tmp/iptv-pgs-ocr'

if [ -s "$output" ]; then
  echo "SKIP $input"
  exit 0
fi

mkdir -p "$(dirname "$output")"
work_dir=$(mktemp -d /private/tmp/iptv-pgs-french.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

subtitle_index=$(node -e "
  const { execFileSync } = require('child_process')
  const input = process.argv[1]
  const streams = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=index,codec_name:stream_tags=language,title',
    '-of', 'json', input
  ], { encoding: 'utf8' })).streams || []
  const french = streams.find(stream => {
    const language = String(stream.tags?.language || '').toLowerCase()
    const title = String(stream.tags?.title || '').toLowerCase()
    return stream.codec_name === 'hdmv_pgs_subtitle' && (
      ['fr', 'fre', 'fra'].includes(language) || /fran.ais|french/.test(title)
    )
  })
  if (french) process.stdout.write(String(french.index))
" "$input")

if [ -z "$subtitle_index" ]; then
  echo "NO_FRENCH_PGS $input" >&2
  exit 2
fi

temp_sup="$work_dir/subtitle.sup"
ffmpeg -v error -y -i "$input" -map "0:$subtitle_index" -c:s copy "$temp_sup"
"$ocr" "$temp_sup" "$output"
echo "DONE $output"
