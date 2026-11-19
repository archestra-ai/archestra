#!/usr/bin/env bash
# Decides whether this release may publish and whether it may move the
# :latest tags. Shared by every publication job so they agree.
# Inputs: VERSION, GH_REPO, GITHUB_REF_NAME, RELEASE_FREEZE, GITHUB_OUTPUT;
# GH_TOKEN must see draft releases (push access).
set -euo pipefail

test "$RELEASE_FREEZE" != true || { echo "::error::Releases are frozen"; exit 1; }
PRESERVE_LATEST=false
if [[ "$VERSION" != *-* ]]; then
  RELEASE_LINE=${VERSION%.*}
  test "${GITHUB_REF_NAME:-}" = "release/$RELEASE_LINE" \
    || { echo "::error::Stable version does not match its release branch"; exit 1; }
  # Fetch every page before comparing: process substitution hides API failures.
  # Include drafts so a partially published newer patch still blocks a downgrade.
  STABLE_TAGS=$(gh api --paginate "repos/$GH_REPO/releases?per_page=100" --jq '.[] | select(.prerelease | not) | .tag_name') \
    || { echo "::error::Cannot verify stable release ordering; retry when the release list is available"; exit 1; }
  while IFS= read -r RELEASE_TAG; do
    [[ "$RELEASE_TAG" =~ ^platform-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    RELEASE_VERSION=${RELEASE_TAG#platform-v}
    [ "$RELEASE_VERSION" != "$VERSION" ] || continue
    # Ubuntu's GNU sort -V compares numeric stable versions.
    if [ "$(printf '%s\n' "$VERSION" "$RELEASE_VERSION" | sort -V | tail -1)" = "$RELEASE_VERSION" ]; then
      if [ "${RELEASE_VERSION%.*}" = "$RELEASE_LINE" ]; then
        echo "::error::Newer stable release ${RELEASE_TAG} exists on this line (published or draft); cannot publish ${TAG_NAME}"
        exit 1
      fi
      # Older lines may ship patches without taking over a newer channel.
      PRESERVE_LATEST=true
    fi
  done <<< "$STABLE_TAGS"
fi
echo "preserve_latest=$PRESERVE_LATEST" >> "$GITHUB_OUTPUT"
