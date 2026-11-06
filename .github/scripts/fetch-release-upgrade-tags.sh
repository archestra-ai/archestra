#!/usr/bin/env bash
# Fetch the newest stable platform-vX.Y.Z tag of each already fetched
# release/X.Y branch from REMOTE: the only tags the migration upgrade replay
# reads (see release-upgrade-tags.py). When GH_TOKEN is set it authenticates
# these git commands only; the token never reaches argv or .git/config.
set -euo pipefail

remote="${1:?usage: fetch-release-upgrade-tags.sh REMOTE}"
scripts="$(cd "$(dirname "$0")" && pwd)"

remote_git() {
  if [ -n "${GH_TOKEN:-}" ]; then
    # shellcheck disable=SC2016 # expanded by git's credential helper shell
    git -c credential.helper= \
        -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
        "$@"
  else
    git "$@"
  fi
}

tags=$(remote_git ls-remote --refs --tags "$remote" 'platform-v*' | python3 "$scripts/release-upgrade-tags.py")
refspecs=()
while IFS= read -r tag; do
  [ -n "$tag" ] && refspecs+=("+refs/tags/${tag}:refs/tags/${tag}")
done <<< "$tags"

if [ "${#refspecs[@]}" -eq 0 ]; then
  echo "No stable release tags to fetch."
  exit 0
fi
echo "Fetching release tags: ${tags//$'\n'/ }"
remote_git fetch --depth=1 --no-tags "$remote" "${refspecs[@]}"
