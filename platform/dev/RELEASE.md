# Release Checklist

Archestra uses two release pipelines:
- **Beta:** Automatic releases from `main` (for example, `1.4.0-beta.2`).
- **Stable:** Tested and approved releases from `release/X.Y` (for example, `1.3.52` or `1.4.0`).

[Release-please](https://github.com/googleapis/release-please-action#supporting-multiple-release-branches) manages versions and changelogs. GitHub Actions builds the artifacts. Only approved stable releases update `latest`.

## Image CVE Gate

Release Please PR updates on `main` and `release/X.Y` must pass image scanning before queue entry. Every update builds the Platform full/slim, MCP Server Base, and p4 Shim candidates from that event's synthetic merge commit. A successful scan applies only to that PR head, base, and merge candidate; a changed revision requires a new run. An API error, build error, scanner error, cancellation, or missing result blocks the gate. The policy remains fixable critical/high CVEs.

Ordinary PRs and merge groups report an explicit no-scan decision. Source/dependency security checks, builds, tests, and E2E checks still run under their existing policies. For an ad hoc byte scan, use **Docker Image Scanning** workflow dispatch with the exact E2E image SHA; the former `run-docker-scan` label does not trigger scans.

Release builds independently scan the exact immutable per-architecture digests before assigning version tags. This includes all published Platform, MCP, p4, Sandbox Base, and Agent Catalog images on both release tracks. Digest artifacts must come from the same workflow run and source revision and contain the complete expected architecture set. Release builds do not reuse previously tagged images or prior scan results. A failure prevents that image's version tag and blocks GitHub release publication; successful sibling builds and the prerelease chart may already exist, so use the existing same-run recovery procedure. Stable publication still requires separate artifact qualification and environment approval. Untagged build digests are uploaded before scanning so Scout can inspect them.

### Roll Out Required Checks

The workflow preserves `Docker Image Scanning (Platform)`, `Docker Image Scanning (MCP Server Base)`, `Docker Image Scanning (p4 Shim)`, and the historical literal `Docker Image Scanning (${{ matrix.name }})` contexts. Each depends on the always-running **Release Image Security** gate. A release scan skipped after a failed prerequisite cannot satisfy these contexts. No repository protection change is required to adopt this compatibility bridge.

1. Merge the workflow change through the current protections. Backport the release tooling to each supported stable branch through its normal protected PR process; changing `main` alone does not update an existing stable branch's workflows.
2. Verify the contexts on an ordinary PR, a Release Please PR update, and a merge group on each track. A release PR must perform real scans; a scan or classification failure must leave the gate and compatibility contexts failed.
3. In a separately approved settings change, replace only the legacy Docker scan contexts with **Release Image Security**, using the existing GitHub Actions integration. Preserve every unrelated required check and queue setting. Keep the compatibility jobs until all applicable rulesets have been read back and verified; remove them in a subsequent PR.

These workflow changes do not fix or suppress current vulnerabilities. Diagnose and repair any blocked release in a separate dependency or image PR.

## Release A Beta

1. [ ] Open the release-please PR on `main` (for example, `1.4.0-beta.2`).
2. [ ] Review the changelog and confirm checks pass, including migration upgrades from the active stable line.
3. [ ] Merge the PR and confirm the **Release Please** workflow publishes the beta release.

## Ship A Stable Fix

1. [ ] Land the fix on `main` first. The fix ships automatically in the next beta.
2. [ ] Add the label `backport release/X.Y` for each configured target (for example, `backport release/1.3`).
   - Add the label before or after the main PR merges.
   - Pushes to `main` and backport labels added after merge trigger processing without waiting for the scheduled scan.
   - A five-minute schedule retries outstanding requests. GitHub can delay scheduled runs; the interval is not a delivery guarantee.
   - **Open Backport PRs** cherry-picks the merged commit with `-x` and opens a separate PR per target.
   - The automation opens PRs; it never merges them or approves stable publication.
3. [ ] Review each generated backport PR, confirm its checks pass, then add it to that branch's merge queue.
   - Only include necessary bug fixes. Do not include new features, refactors, or schema migrations.
   - Conflicts and schema changes produce a manual-action comment instead of a pushed backport.
   - Never merge `main` into a release branch.
   - Review the migration compatibility check. A green result does not permit schema migrations in a stable fix.
4. [ ] Merge the generated release-please patch PR on `release/X.Y` (for example, `1.3.52`).
5. [ ] Complete **Test And Approve Stable** below.

### Backport Targets And Recovery

`.github/backport-targets.json` is the explicit list of branches that accept automatic backport requests.
Add each new stable or candidate branch there, and create its `backport release/X.Y` label.
Remove retired branches from that list when making them read-only.
The workflow always runs trusted automation from the default branch, including manual retries.
Automatic backports only accept merged PRs from branches in this repository targeting the default branch.
PRs from forks are ineligible, including through scheduled scans and manual retries.
Each automatic run scans all outstanding labels, so overlapping triggers can share one job.

Use **Open Backport PRs → Run workflow** to retry a merged main PR.
Supply its number and, optionally, one configured target branch.
An existing backport PR, including a closed PR, is not duplicated or reopened.
Label requests remain discoverable after workflow outages. Remove the request label when abandoning a backport.
An existing backport branch is never force-pushed or reset.
A push that succeeded before PR creation failed can resume if its source provenance matches.

For conflicts, create a manual branch from the release target and resolve the cherry-pick:

```bash
git checkout -b backport/fix-name origin/release/X.Y
git cherry-pick -x <main-commit-sha>
```

Open a PR against `release/X.Y` and complete the same review and release checks.
A schema migration is not eligible for automatic backporting; prepare a stable fix without it.

The workflow uses the existing release GitHub App token so generated PRs trigger CI.
Backport PRs receive the usual reviewer assignment and run checks even though the release App authored them.

## Migration Compatibility Across Release Tracks

A higher application version does not guarantee a compatible migration history.
Drizzle runs migrations newer than the database's latest recorded journal timestamp.
A stable backport can advance that timestamp past beta-only migrations.
The next beta upgrade can then report success while required columns remain missing.

PR validation checks upgrades within a release line and from stable to main.
Backport PRs also check their resulting stable history against main.
Release creation repeats the check against the current branch refs.
Keep these guards on both main and the active stable branch.

The checker recognizes identical SQL under different backport filenames.
It rejects migrations that would be skipped or replayed, and missing source SQL.
It does not validate SQL semantics, dependency order, or database lock safety.
Continue testing the actual upgrade against the saved release artifacts.

If a published release already created a gap:

1. Add a new idempotent repair on main, newer than both migration histories.
2. Cover every skipped change and preserve values on already-migrated databases.
3. Register the reviewed SQL hashes in `backend/src/database/migrations/upgrade-repairs.json`.
4. Test with the real Drizzle migrator, including a database whose ledger already advanced past the gap.
5. Publish the repaired beta before directing affected stable installations to that beta.

Do not edit shipped migration SQL, renumber its timestamps, or rewind a database's migration ledger.
The ordinary backend test snapshot executes SQL directly and cannot detect timestamp-based skips.
See [migration upgrade checks](../backend/src/database/migrations/README.md) for commands and repair coverage rules.

## Cut A New Stable Feature Line

1. [ ] Choose a tested beta tag (for example, `platform-v1.4.0-beta.2`).
2. [ ] Create `release/1.4` from that tag (not from `main`):
   ```bash
   git checkout -b release/1.4 platform-v1.4.0-beta.2
   git push origin release/1.4
   ```
3. [ ] Open a PR to `release/1.4` configuring `.github/release-please/release-please-config.json` with the **Stable cut** settings below. Merge it.
4. [ ] Merge the generated `1.4.0` release PR on `release/1.4`, then complete **Test And Approve Stable**.
5. [ ] After `1.4.0` publishes, remove `release-as` from `release/1.4`. Future patches become `1.4.1`, `1.4.2`, etc.
6. [ ] On `main`, open a PR setting the **Next beta** configuration below. Merge it.
7. [ ] After `1.5.0-beta.1` publishes, remove `release-as` from `main`.

### Release Please Configuration

Edit `packages.platform` in `.github/release-please/release-please-config.json`:

| Field | Stable cut (`release/1.4`) | Next beta (`main`) |
| --- | --- | --- |
| `versioning` | `always-bump-patch` | `prerelease` |
| `prerelease` | `false` | `true` |
| `prerelease-type` | Remove field | `beta` |
| `release-as` (temporary) | `1.4.0` | `1.5.0-beta.1` |
| `draft` | `true` | `true` |

`draft: true` creates a draft GitHub release. It does not make the pull request a draft.

## Test And Approve Stable

Merging a release PR on `release/X.Y` builds the artifacts and waits for `stable-release` environment approval. Test these exact artifacts before approving:

1. [ ] Confirm all build jobs in the workflow run completed successfully.
2. [ ] Download the `release-helm-chart` and `release-image-*` workflow artifacts.
3. [ ] Install the saved chart in a test environment with `ARCHESTRA_BETA=false`. Confirm image digests match the build.
4. [ ] Test a clean install and an upgrade from the previous stable version:
   - Verify database migrations, sign-in, chat, MCP tools, LLM proxy, and background workers.
   - Confirm existing data remains intact after upgrade.
5. [ ] Have a second maintainer approve the `stable-release` environment in GitHub Actions.
   - Add a brief, sanitized test summary in the approval comment. Never include sensitive data.
   - A rerun or new candidate requires a fresh approval after its artifacts are verified.
6. [ ] Confirm the workflow publishes the GitHub release, updates Helm charts, and points Docker `latest` to the new version.

## Troubleshooting

- **Build failure:** Inspect the failure and re-run failed jobs in the same workflow run.
- **Testing fails before approval:**
  1. Cancel the workflow run.
  2. Delete the GitHub draft release. Keep the git tag. (Unapproved draft releases block other releases).
  3. Fix the issue on `main`, backport to the release branch, and cut a new version. Never reuse an existing version number.
- **Partial publication:**
  1. Do not publish artifacts or move `latest` manually.
  2. Inspect GitHub releases and container registries.
   3. Keep the existing draft release and git tag. Re-run failed jobs in the original workflow run using the saved artifacts.
   4. Obtain explicit authorization before approving a retry that waits for `stable-release`.
   5. If the retry fails or state remains inconsistent, stop and investigate.

<details>
<summary>One-time setup — initial rollout</summary>

1. [ ] Freeze existing release automation and close obsolete release PRs.
2. [ ] Create GitHub environment `beta-release` without required approvals.
3. [ ] Create GitHub environment `stable-release` with required reviewers, self-review prevention, and deployment restricted to `release/*`.
4. [ ] Add branch protection rules for `release/*`.
5. [ ] Create `release/1.3` from the latest stable tag (`platform-v1.3.51`). In its release-tooling-only PR, keep the manifest at that tag's version; set `versioning: always-bump-patch`, `prerelease: false`, and `draft: true`; remove `release-as` and `prerelease-type`.
6. [ ] On `main`, configure beta settings with temporary `release-as: 1.4.0-beta.1`.
7. [ ] Confirm registry credentials work for release branches.
8. [ ] Unfreeze releases once branches and environments are ready.

</details>
