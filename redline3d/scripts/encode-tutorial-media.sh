#!/usr/bin/env bash
set -euo pipefail

RAW_DIR="${1:-}"
if [[ -z "$RAW_DIR" ]]; then
  echo "usage: $0 /absolute/path/to/raw-mov-directory" >&2
  exit 2
fi

MISSING_TOOLS=()
for TOOL in ffmpeg ffprobe cwebp; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    MISSING_TOOLS+=("$TOOL")
  fi
done
if (( ${#MISSING_TOOLS[@]} > 0 )); then
  printf 'missing required tool: %s\n' "${MISSING_TOOLS[@]}" >&2
  exit 5
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/tutorial"
mkdir -p "$OUT"

FILTER="fps=24,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
NAMES=(drive lobby market-side leverage cash-out)

for NAME in "${NAMES[@]}"; do
  INPUT="$RAW_DIR/$NAME.mov"
  if [[ ! -f "$INPUT" ]]; then
    echo "missing raw capture: $INPUT" >&2
    exit 3
  fi

  DURATION="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$INPUT")"
  if ! awk -v duration="$DURATION" 'BEGIN { exit !(duration >= 5 && duration <= 8.2) }'; then
    echo "$NAME.mov must be between 5.0 and 8.2 seconds, got $DURATION" >&2
    exit 4
  fi

  OUTPUT_DURATION=8
  if [[ "$NAME" == "cash-out" ]]; then
    OUTPUT_DURATION=5.16
  fi

  ffmpeg -y -i "$INPUT" -t "$OUTPUT_DURATION" -an -vf "$FILTER" \
    -c:v libvpx-vp9 -b:v 240k -maxrate 320k -bufsize 640k \
    -deadline good -cpu-used 2 -row-mt 1 "$OUT/$NAME.webm"

  ffmpeg -y -i "$INPUT" -t "$OUTPUT_DURATION" -an -vf "$FILTER" \
    -c:v libx264 -profile:v high -level 4.0 -b:v 640k -maxrate 700k -bufsize 1400k \
    -movflags +faststart "$OUT/$NAME.mp4"

  ffmpeg -loglevel error -ss 1 -i "$OUT/$NAME.webm" -frames:v 1 \
    -f image2pipe -c:v png - | cwebp -quiet -q 82 -o "$OUT/$NAME.webp" -- -
done
