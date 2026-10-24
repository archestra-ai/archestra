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

## Immutable publication handoff

Publication uses the retained Docker archives; it does not rebuild release
images. The existing release job selects the latest queue scan of the exact
release tree on the correct branch. A failed, pending, cancelled, incomplete,
expired or unavailable latest matching run cannot fall back to an older success.
PR and manual-dispatch runs are not publication evidence.

The gate uploads a complete candidate index only after every native leg and the
revision/input checks pass. Selection verifies repository, workflow path, queue
branch, source SHA/tree, latest run attempt, gate and leg results, all inventory
entries, age and GitHub artifact checksums. Each image archive must also match
its recorded payload checksum and build metadata. Synthetic and final commit IDs
can differ; their trees and explicit build inputs must agree.

The existing `archestra-ci` release App already has `actions: read`. This was
confirmed using read-only installation metadata (App ID 1667068, matching the
release PR author), not by changing the installation or requesting extra token
permissions. Its token remains in the original release job. That job relays one
verified architecture archive at a time into same-run artifacts, limiting disk
usage and keeping App credentials out of publisher jobs, outputs and artifacts.
Publisher token permissions are unchanged. Relay, digest and image-reference
artifact names include the publication attempt, so a new attempt cannot mix
earlier transfer or publication results; it must relay the complete set again.

Publisher jobs verify the relayed archive, source tree, version and previous
asset inputs, load it, and check the original image config ID and architecture.
They push a run/attempt-specific intermediate reference, verify the registry
config ID, and pass the resulting immutable architecture index to the existing
publication scans. Both architecture scans must pass before a version image tag
is assigned. There is no missing-artifact or legacy-release rebuild fallback.
Older interrupted releases without this evidence fail closed; this work does
not run or repair those releases.

The guarantee is identity of the scanned runtime config and rootfs layers.
Docker archives and registry manifests have different encodings and digests;
config/rootfs identity, archive checksums and registry digests are checked at
their respective boundaries. Docker save does not retain Buildx's optional OCI
attestation manifests. The complete authenticated Actions candidate index is
retained as the handoff audit record; consumers requiring Buildx attestation
manifests need an OCI-preserving extension before adopting this publication path.
No attestation is fabricated or claimed to have been verified.

New advisories after the candidate scan can still make publication fail even
with identical image bytes. Artifact expiration, registry failures, runner
capacity and access errors can also fail closed. Green candidate checks are not
a promise of successful publication under every later condition.

## Verification and rollout

The deterministic fixtures execute the actual release-PR and merge-group gate
CLI against local Git commits and controlled GitHub responses. Handoff fixtures
exercise selection, complete inventories, both architecture archives, synthetic
versus final commit IDs, checksum and metadata tampering, rerun attempts, latest
failures, wrong workflow/event/repository/branch, and same-run transfer and image
identity checks. Docker/registry operations are stubbed at their external boundary;
these tests never build vulnerable images, reproduce exploits, or push images.

Regular feature and fork PRs skip candidate Docker CVE scans. Their hosted policy
jobs exercise these fixtures, and workflow-input changes can independently run
catalog build validation. Neither is a release execution.

A bounded hosted rehearsal creates tiny marker-only scratch images on the two
work branches. Explicit handoff-fixture dispatch skips every production step,
mints a read-only token in the existing App job, relays the fixture across runs,
and loads both archives in a consumer without the App token. It does not scan
CVEs, push images, create tags or publish releases. Fixture artifacts cannot be
selected as production scan evidence.

Real catalog archive size, native build/scan duration, relay throughput and
registry transport still need operational review before marking these drafts
ready. Both live queues allow 30 minutes for required
checks; runner capacity or larger builds can fail closed at that timeout. No live
rules, credentials, pending releases, aliases or approvals are changed for this
verification. Both PRs should remain draft until those operational checks and the
attestation-format change have been reviewed.
