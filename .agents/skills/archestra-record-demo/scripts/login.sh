#!/usr/bin/env bash
# Save a logged-in browser session for recording, keeping only the target
# site's cookies (a Google SSO login otherwise drags in every Google cookie).
# Interactive: the user runs this in a real terminal, not through `!`.
set -euo pipefail

url="${1:?usage: login.sh <base-url> <auth.json>}"
out="${2:?usage: login.sh <base-url> <auth.json>}"
host="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$url")"

uvx shot-scraper auth -b chrome "$url" "$out"

# Keep cookies whose domain is the host or a parent of it (.archestra.dev).
jq --arg host "$host" '
  .cookies |= map(select(.domain | ltrimstr(".") as $d | $host == $d or ($host | endswith("." + $d))))
  | .origins |= map(select(.origin | contains($host)))' "$out" > "$out.tmp"
mv "$out.tmp" "$out"
chmod 600 "$out"
echo "saved $(jq '.cookies | length' "$out") cookies for $host to $out"
