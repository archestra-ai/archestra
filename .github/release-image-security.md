# Release candidate scan contract

The required compatibility contexts depend on `Release Image Security`. A green
candidate gate means that every configured candidate image passed the unchanged
Critical/High, fixable-CVE policy on both `linux/amd64` and `linux/arm64` for the
tested source revision and workflow attempt. It does **not** guarantee that a
later release publication will succeed.

## Events and revision binding

- Release Please PRs receive the required classification and compatibility
  contexts without building or scanning candidate images. The merge queue scans
  the exact combined revision once a version-changing group is constructed.
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
- It also resolves the single open Release Please PR and reconstructs its merge
  **tree** with `git merge-tree --write-tree` from the exact PR head and the
  merge group's immutable base commit. GitHub's asynchronously computed
  `merge_commit_sha` and PR REST `base.sha` are not used for this comparison:
  either can be missing or stale during concurrent merges.
  Missing Git objects, conflicts or an invalid merge result fail closed.
- The entire reconstructed tree must equal the scanned group's tree. A mixed
  group whose release would contain different source still fails closed with
  the PR number, head/base SHAs and both trees in the diagnostic. Validate that
  release's exact source in its own group; a successful scan of later queued
  code cannot stand in for the earlier release commit's contents. No paths,
  including generated documentation, are excluded from this comparison.
- After checking all evidence, the gate rechecks the PR's open state, exact
  head and target branch plus the queue ref before writing the candidate index.
  The index retains the PR number, exact head and queue base SHAs, and
  reconstructed tree for audit.

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

Each successful native scan retains its OCI archive and metadata for one day.
The gate requires exactly one evidence record per image/architecture, with the
current repository, source SHA/tree, run ID, run attempt, version, previous-image
digest, image config ID, archive checksum and successful scan outcome. Evidence
older than 24 hours, missing or duplicate records, other architectures, and any
failed/skipped/cancelled/neutral scan block all compatibility contexts. Job
success alone cannot supply missing evidence; records from earlier rerun attempts
are not selected.

## Immutable publication handoff

Publication uses the retained OCI archives; it does not rebuild release
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
asset inputs, then copy the OCI layout using the preinstalled Skopeo client with
`--all --preserve-digests`. Release promotion uses Ubuntu 24.04 runners for both
architectures; copying manifests and blobs does not execute image code. Native
candidate builds and scans remain native on each architecture. No CI tool or
package dependency is installed or changed.

The archive verifier hashes every OCI blob, checks the scanned image config,
architecture, exactly one runnable image, attestation binding and SLSA provenance
subject. The publisher verifies that the registry contains that exact runnable
manifest/config and every original attestation manifest. BuildKit's provenance
is retained as emitted; it is not dropped, rewritten or recreated by publication.
The complete candidate index is an additional authenticated handoff audit record.

The existing publication scans consume those immutable architecture indexes.
Both scans must pass before a version image tag is assigned. There is no missing-
artifact or legacy-release rebuild fallback. Older interrupted releases without
this evidence fail closed; this work does not run or repair those releases.

The guarantee covers identical runtime config, rootfs layer identities and OCI
provenance payloads across candidate scanning and publication. Archive ZIP/TAR
encodings and outer registry indexes have distinct digests; each boundary checks
its appropriate checksum or immutable manifest/config identity.

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

All PRs skip candidate Docker CVE scans; version-changing merge groups require
them. Hosted policy jobs exercise the fixtures, and workflow-input changes can
independently run catalog build validation. Neither is a release execution.

A bounded hosted rehearsal creates tiny marker-only scratch images on the two
work branches. Explicit handoff-fixture dispatch skips every production step,
mints a read-only token in the existing App job, relays the fixture across runs,
and verifies both image identities plus an OCI-to-OCI copy of the original
provenance in a consumer without the App token. It does not scan
CVEs, push images, create tags or publish releases. Fixture artifacts cannot be
selected as production scan evidence.

The release/1.4 merge-group
[run 40102128984](https://github.com/archestra-ai/archestra/actions/runs/40102128984)
completed all 20 native scan legs successfully, then its source gate rejected
the live cached test-merge comparison. Reconstructing its recorded PR head
`0403e1bbfbcd0e4e33f811b91136790fb01fd2f8` with base
`c77da4df51fba5d5b7f2bfbe7d26d7669c8cf7c9` produces tree
`c842516980963dd766bdf33ef34cc8e304e8f876`, exactly the scanned queue tree.
The old log did not record the API's cached test-merge SHA/tree, so whether that
response was stale or unavailable cannot be established retrospectively. The
regression fixture reproduces both cases and checks the exact-source replacement
without running a release; genuinely mixed groups still fail.

Real catalog relay throughput and production registry transport remain untested
by these non-publishing fixtures. Both live queues allow 30 minutes for required
checks; runner capacity or larger builds can fail closed at that timeout. No live
rules, credentials, pending releases, aliases or approvals are changed for this
verification.
