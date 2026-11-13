#!/usr/bin/env bash
# Record a shot-scraper storyboard into <out-dir>/demo.mp4 plus a contact
# sheet for review. Storyboards may use a `- caption: "text"` action, which is
# expanded into an on-page caption overlay (no ffmpeg subtitle filters needed,
# and captions are timed by construction).
set -euo pipefail

storyboard="${1:?usage: record.sh <storyboard.yml> <auth.json> <out-dir>}"
auth="${2:?usage: record.sh <storyboard.yml> <auth.json> <out-dir>}"
out="${3:?usage: record.sh <storyboard.yml> <auth.json> <out-dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"

uv run --quiet --with pyyaml python3 "$here/expand_captions.py" "$storyboard" > "$out/storyboard.expanded.yml"
uvx shot-scraper video "$out/storyboard.expanded.yml" -b chrome -a "$auth" -o "$out/demo.webm" --mp4

duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/demo.mp4")
# 12 evenly spaced frames, tiled, so the recording can be checked without playing it.
ffmpeg -loglevel error -y -i "$out/demo.mp4" -vf "fps=12/$duration,scale=640:-2,tile=4x3" -frames:v 1 "$out/contact-sheet.png"

size=$(wc -c < "$out/demo.mp4")
echo "demo: $out/demo.mp4 ($((size / 1024)) KB, ${duration%.*}s)"
echo "contact sheet: $out/contact-sheet.png"
