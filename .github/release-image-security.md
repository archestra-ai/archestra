# Release candidate scan contract

The required compatibility contexts depend on `Release Image Security`. A green
candidate gate means that every configured candidate image passed the unchanged
Critical/High, fixable-CVE policy on both `linux/amd64` and `linux/arm64` for the
tested source revision and workflow attempt. It does **not** guarantee that a
later release publication will succeed.

## Events and revision binding

- Release Please PRs scan their live test-merge revision and recheck their open
  state, head, base and current test-merge SHA after scanning.
- Merge groups targeting `main` or `release/X.Y` compare the platform manifest at
  the event's exact base and head commits. Any version change scans the **whole
  combined group**, even when its queue branch names an ordinary PR. No PR
  membership, branch-name heuristic, label, or previous PR scan substitutes for
  the combined revision. Missing Git objects or manifests fail classification.
- Groups without a version change and ordinary feature/fork PRs retain an
  explicit successful classification and skipped scan. A manual byte scan keeps
  its separate scope; it is not release-candidate evidence.
- The gate rechecks the queue ref still points at the scanned group SHA. GitHub's
  merge queue remains responsible for invalidating superseded groups.
- It also resolves the single open Release Please PR and compares its current
  test-merge **tree** with the scanned group's tree. A mixed group whose release
  would contain different source fails closed with an explicit request to
  validate the release in its own group. A successful scan of later queued code
  cannot stand in for the earlier release commit's contents.

The matrix derives agents from this branch's catalog and includes Platform full
and slim, MCP, p4 and sandbox. The publisher-inventory regression follows release
workflow callers, including new companion images and catalog targets.

## Build and evidence contract

Both architectures build and scan natively. Scout 1.24.0's AMD64 and ARM64 CLI
archives have separate pinned checksums from the
[official release](https://github.com/docker/scout-cli/releases/tag/v1.24.0).

Candidate and publication builds read `VERSION` from the source manifest. For
Platform, both resolve the preceding release from the source commit's parent,
then pin the previous frontend assets to the matching architecture's immutable
Docker Hub digest. A missing pull, container, copy, architecture or digest is a
failure; release builds cannot quietly omit these assets. Candidate Platform
builds use the publisher's existing Sentry build secret because its injection
step changes the generated backend. No credentials or token scopes are changed.

Each successful native scan retains its Docker archive and metadata for one day.
The gate requires exactly one evidence record per image/architecture, with the
current repository, source SHA/tree, run ID, run attempt, version, previous-image
digest, image config ID, archive checksum and successful scan outcome. Evidence
older than 24 hours, missing or duplicate records, other architectures, and any
failed/skipped/cancelled/neutral scan block all compatibility contexts. Job
success alone cannot supply missing evidence; records from earlier rerun attempts
are not selected.

## Immutable promotion remains a limitation

Publication still **rebuilds** images. The saved archives establish which bytes
passed candidate scans, but this change does not promote them across runs.
Matching source and explicit inputs cannot make a networked Docker build
reproducible: package repositories, external downloads, cache state, generated
IDs and the difference between a queue/test-merge commit and its eventual merge
can still change the output. New advisories can also appear after a scan even
when the image bytes remain identical.

Safe reuse would require a trusted handoff that verifies the source **tree**
(synthetic and final commit IDs may differ), release version, complete image and
architecture inventory, build inputs, successful latest workflow attempt, age,
archive checksum and loaded image identity. Publication must re-scan those exact
bytes against current advisories before assigning version tags. Expired, missing,
unavailable or mismatched archives must fail, never fall back to an unverified
rebuild or an older successful run.

The current image jobs do not declare the `actions: read` permission required for
[cross-run artifact downloads](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact).
This task prohibits expanding permissions. The existing release App token's
artifact authority is not assumed or propagated to image jobs. A trusted
cross-run promotion design under the existing permission constraint remains
unfinished; these PRs are a coverage/parity improvement, not that stronger
guarantee. Independent publication scans and final release gates remain in place.

## Verification still required

The deterministic policy fixtures exercise mixed queue groups, stale/live
revisions, complete inventories, both architectures and failure results without
building vulnerable images or reproducing exploits. Ordinary draft-PR hosted
checks run those fixtures but intentionally skip expensive candidate builds.
A real release-PR/queue run is still required to establish native build/scan
duration and artifact retention behavior. Both live queues currently allow 30
minutes for required checks; runner capacity or larger builds can fail closed on
that timeout. No live rules, pending releases, aliases or release approvals were
changed to test this work.
