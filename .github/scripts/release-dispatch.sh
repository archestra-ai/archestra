#!/usr/bin/env bash
# Asks the release publisher to copy the attested ci/ digests, and the
# attested chart from this run, to their public names, then waits for its run.
# Inputs: VERSION, PRESERVE_LATEST, PLATFORM_LATEST, CHART (the chart archive,
# optional), PUBLISHER_REPO, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT; GH_TOKEN may
# dispatch to and read Actions runs of PUBLISHER_REPO.
set -euo pipefail

images_file=$1
latest=false
if [[ "$VERSION" != *-* && "$PRESERVE_LATEST" == false ]]; then
  latest=true
fi
chart=null
if [ -n "${CHART:-}" ]; then
  # The publisher downloads release-helm-chart from this run and checks it.
  chart=$(jq -n --argjson run "$GITHUB_RUN_ID" --arg sha "$(sha256sum "$CHART" | cut -d' ' -f1)" \
    '{run_id: $run, sha256: $sha}')
fi
request_id="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
jq -n --arg id "$request_id" --arg version "$VERSION" --argjson latest "$latest" \
  --argjson platform_latest "${PLATFORM_LATEST:-false}" --argjson chart "$chart" \
  --slurpfile images "$images_file" \
  '{event_type: "publish-release-images",
    client_payload: ({request_id: $id, version: $version, latest: $latest,
                      platform_latest: $platform_latest, images: $images[0]}
                     + if $chart then {chart: $chart} else {} end)}' \
  | gh api -X POST "repos/$PUBLISHER_REPO/dispatches" --input -

# The dispatch API returns no run ID; the publisher puts request_id in its run name.
run_id=
for _ in $(seq 1 40); do
  run_id=$(gh api "repos/$PUBLISHER_REPO/actions/runs?event=repository_dispatch&per_page=50" \
    --jq "[.workflow_runs[] | select(.display_title | endswith(\"[$request_id]\"))][0].id // empty")
  [ -n "$run_id" ] && break
  sleep 6
done
[ -n "$run_id" ] || { echo "::error::The release publisher did not start"; exit 1; }
echo "Publisher run: https://github.com/$PUBLISHER_REPO/actions/runs/$run_id"
gh run watch "$run_id" --repo "$PUBLISHER_REPO" --exit-status --interval 20
