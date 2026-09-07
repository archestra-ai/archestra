# Platform Releases

## Release Contract

Archestra supports one stable feature line at a time.
Patch releases contain reviewed fixes, not ongoing feature work.
Feature releases target a monthly cadence. Failed qualification delays the release.
The existing line remains supported until the next stable feature release is published.
Older versions remain downloadable, but receive no further fixes after that transition.

| Source | Version example | Audience |
| --- | --- | --- |
| `main` | `1.4.0-beta.N` | Development, integration testing, and explicit preview adopters |
| `release/1.4` after qualification | `1.4.0`, then `1.4.1` | Stable installations |

Versions here are examples. Read GitHub's latest stable release before choosing a line.
A `-beta.N` version suffix names a preview release. Release-please increments that suffix on `main`.
The `ARCHESTRA_BETA` feature flag controls experimental product behavior. Installing a beta version does not enable the flag.
Backward-compatible features increment the minor version. Breaking public contracts require a major version.
The latest published stable GitHub release identifies the supported line.
Only **Publish Stable Release** changes that pointer.

## Developer Workflow

Develop features and reproduce bugs on `main` through normal PRs.
Keep fixes separate from refactoring so they can be backported independently.
Do not merge `main` into a release branch, or merge a release branch back into `main`.

The release owner chooses a known-good commit when cutting a feature branch.
Branch creation does not remove unfinished code already present at that commit.
Audit the included changes before cutting, not just the visible feature list.

Small, isolated features may ship disabled after testing their disabled paths.
An incomplete change to shared execution, startup, authorization, or schema is not isolated by a UI flag.
Finish it, exclude it from the cut, or defer the release.
Flags remain useful for opt-in previews; they are not a release boundary.

### Backports

Start a short-lived branch from the supported `release/X.Y` branch.
Cherry-pick the tested fix with `git cherry-pick -x <commit>`.
Resolve conflicts deliberately; do not include prerequisite feature work to make a fix apply.
Open a PR against `release/X.Y`, with this information:

```text
Backport-of: <full commit SHA already merged into main>

Problem: <public-safe description>
Scope: <why the change is needed on this line>
Risk: <behavior affected, dependencies, and conflict resolutions>
Verification: <regression test and checks on the release branch>
```

The Release Policy check rejects feature/refactor titles and missing main-commit references.
It does not prove that a change is a safe fix. A maintainer reviews the actual diff.
Version/configuration-only PRs do not require a backport reference.
Security dependency updates are eligible fixes; unrelated dependency refreshes are not.
Do not bypass this policy by changing the title of a feature PR.

For a bug absent from `main`, first merge its regression test or an equivalent prevention change there.
Reference that commit and explain why the release branch needs a different implementation.

### Migrations

Patch releases do not add or change schemas or migration history.
A fix requiring those changes needs a separately qualified feature release, which may ship early.
Never copy a migration journal or snapshots wholesale from `main` into a stable line.

For feature releases, review migration ordering, write locks, mixed-version operation, and data preservation.
Use forward-compatible changes when old and new application processes overlap.
Test upgrades from the latest supported patch, including fixes made during beta qualification.
An application or Helm rollback does not undo a database migration.
Record whether recovery uses compatible old binaries, a forward fix, or a tested backup restore.
Do not test against production data or put database contents in public evidence.

## Rolling Beta And Patch Releases

The tools require Python 3, Git, GitHub CLI, Docker Buildx, and Helm for their respective steps.
Run commands from `platform/` in a dedicated worktree.

Release-please keeps one rolling release PR on each active branch:

- `main` produces `1.4.0-beta.N` with prerelease versioning and prerelease type `beta`.
- `release/1.3` produces `1.3.N` with `always-bump-patch` versioning.

Normal changes update these release PRs. There is no separate request PR for every version.
Keep each branch's release-please manifest and configuration on that branch.
Never copy stable versions or release metadata back to `main`. Main retains its beta ancestry.

Use `prepare` only to configure a cutover or clear a temporary override. It edits release-please configuration only.
It does not commit, push, or publish.

### Seed The First Rolling Beta

For the initial cutover from stable `1.3.50`, prepare `main` with a temporary `release-as`:

The initial configuration in this PR already seeds `1.4.0-beta.1`.
The command below is also available for subsequent cutovers.

```bash
git fetch origin --tags
python3 ../.github/scripts/release-policy.py prepare 1.4.0-beta.1 --branch main
git diff -- ../.github/release-please/release-please-config.json
```

Merge the configuration change through normal review. Merge the release-please PR for `1.4.0-beta.1`.
Wait for its release and tag to be built successfully. Then clear the temporary override by preparing the same current version:

```bash
python3 ../.github/scripts/release-policy.py prepare 1.4.0-beta.1 --branch main
```

Merge that configuration-only change through review. Native prerelease versioning then rolls `beta.2`, `beta.3`, and later betas automatically.

Do not seed `1.5.0-beta.1` while `1.4` is still in qualification.
After `1.4.0` is published, start the next train on `main` with:

```bash
python3 ../.github/scripts/release-policy.py prepare 1.5.0-beta.1 --branch main
```

During a stable cutover, freeze merges to the rolling beta PR on `main` until the next train is seeded.
Otherwise merged changes can publish additional betas on the old feature line with no supported promotion path.

### Cut A Stable Feature Line

1. Select the tested `platform-v1.4.0-beta.N` tag. Create `release/1.4` from that tag, not from a later `main` commit.
2. On the new branch, prepare the stable version:

   ```bash
   git fetch origin --tags
   python3 ../.github/scripts/release-policy.py prepare 1.4.0 --branch release/1.4
   git diff -- ../.github/release-please/release-please-config.json
   ```

   Commit the configuration-only final-version request and open a PR against `release/1.4`.
3. After that PR merges, release-please updates its stable version/changelog PR on the branch.
   Review its scope and wait for normal PR checks before merging it.
4. The merged stable PR builds versioned images and a packaged chart.
   The workflow attaches the chart and `release-artifacts.json` to the draft release.
   Stable releases remain drafts until qualification and protected publication finish.
5. After qualification and stable publication succeed, clear the temporary override with the same version:

   ```bash
   python3 ../.github/scripts/release-policy.py prepare 1.4.0 --branch release/1.4
   ```

   Merge the configuration-only change through review. Native `always-bump-patch` versioning then rolls patches automatically.

The final-version configuration PR must contain no product changes beyond the qualified beta candidate.
Keep the manifest under release-please's control; do not edit it to skip beta releases or version checks.
Do not advance a release branch while its final stable build is being qualified.
Publication requires the branch head to match the release tag.

### Bootstrap An Existing Maintenance Line

Create `release/1.3` from the latest stable `platform-v1.3.N` tag.
Apply the release tooling through a reviewed PR without importing feature work.
Configure native patch versioning by preparing the same stable version on that branch:

```bash
python3 ../.github/scripts/release-policy.py prepare 1.3.50 --branch release/1.3
```

Backport fixes before merging the rolling release-please PR. Release-please calculates the next `1.3.N` patch automatically.

## Qualify The Final Artifacts

The final version is a separate build from the beta release because version metadata changes.
Do not claim it is bit-for-bit identical to the beta release. Qualify the final build itself.
Publication reuses that final build; it does not rebuild images or repackage the chart.

1. Wait for the entire **Release Please** build run to succeed.
2. Download `release-artifacts.json` and the chart archive from its draft GitHub release.
3. Record the manifest's SHA-256, release commit, version, and build run in a qualification issue.
   Use the **Release Qualification** issue template.
4. Deploy the downloaded chart to a disposable qualification installation, not the development environment.
   Keep `ARCHESTRA_BETA=false` and omit explicit experimental feature opt-ins.
   Verify the deployed image digests against the manifest.
5. Exercise a fresh installation and an upgrade from the latest supported stable patch.
   Seed the old installation with fictional users, teams, permissions, conversations, and integrations.
   Check that these records and access restrictions survive the upgrade.
6. Exercise sign-in, authorization, chat, LLM proxy, MCP tools, workers, and changed workflows.
   Check disabled paths of included experimental features.
   Record actual results, supported deployment modes, and both image architectures where applicable.
7. Document migration safety and recovery. Check for new errors and resource regressions.
   For a feature release, allow several working days of representative use, initially three.
   Patch qualification may be shorter when its scope is small; record why.

The checklist is a human qualification gate, not a claim of automated upgrade coverage.
Existing PR tests cannot replace exercising released binaries against an existing installation.
If the supported patch advances during beta testing, repeat upgrade qualification from that patch.
Any rebuilt image or changed chart invalidates the recorded identity and requires requalification.

All issues, logs, release assets, and workflow inputs in this repository are public-facing.
Use fictional test data and sanitized results only.
Never include customer names, account identifiers, credentials, private hostnames, internal links, or raw operational logs.
Keep private evidence in approved private storage; publish only a sanitized outcome, without its private URL.

## Publish Stable

Run **Publish Stable Release** from `main` with:

- `version`: the final stable version, without `platform-v`.
- `build_run_id`: the successful build run for that exact commit.
- `manifest_sha256`: the checksum used during qualification.
- `qualification_issue`: the public-safe checklist issue number.
- `qualified`: true only after all required qualification work passes.

The `stable-release` environment requires an independent maintainer's approval.
The reviewer checks the issue, version, build, and manifest identity before approving.
The workflow checks the supported line, exact build commit, artifact-recording job, and artifact identities.
It rejects beta releases, retired lines, mismatched builds, changed artifacts, and an active release freeze.

It publishes the preserved Helm archive, updates companion image aliases, and updates platform `latest` last.
It then publishes the stable GitHub release and refreshes the release website.
Registry writes and GitHub publication are not one atomic transaction.
Use pinned versions or digests rather than floating aliases in production.

After publication:

1. Verify the chart, image aliases, and GitHub latest release agree.
2. Close the qualification issue with the public release link.
3. Keep stable release metadata on its release branch. Never synchronize it into `main`.
4. Seed the next beta train on `main`, then unfreeze its rolling release PR.
5. When a new feature line becomes stable, retire the preceding line. Do not delete its tags or releases.

## Failure And Recovery

- **Build failure:** leave the release draft. Re-run failed jobs on the original build run.
  Do not use “re-run all jobs” after an artifact upload succeeded, or rebuild a published version.
  A new workflow dispatch may be a no-op after release-please consumed the release PR; it is not build recovery.
- **Qualification failure:** keep the version off the stable channel. Fix and request a new version.
  Clear a consumed final-version override before backporting the fix; the rolling PR calculates the next patch.
  A rejected final feature version advances to its first patch and still needs full feature qualification.
  Rejected drafts consume version numbers; published versions can skip those numbers.
  Do not delete or overwrite tags to reuse a version number.
- **Partial publication:** inspect what succeeded, then rerun publication with the same qualified inputs.
  Republishing the current release is permitted; moving `latest` backwards is not.
  If a registry rejects an already-present chart, compare its archive checksum before skipping that write.
- **Regression after publication:** prefer a narrow patch or forward fix. Never rebuild the same version.
  Downgrading requires checking schema compatibility and the recorded recovery plan.
- **Release freeze:** both version creation and stable publication stop. Development on `main` continues.

## Maintainer Setup And Cutover

These are explicit repository-administration steps, not effects of merging the tooling PR:

1. Freeze releases and let any in-flight old publisher finish. Close obsolete release-please PRs against `main`.
2. Configure the `stable-release` GitHub environment before the first publication.
   Require an independent reviewer, prevent self-review, and allow deployment only from `main`.
   Do not rely on GitHub automatically creating an unprotected environment with that name.
3. Set `RELEASE_AUX_IMAGE_REGISTRY` to the companion images' existing `image_registry` prefix.
   Reuse existing publishing credentials; do not put their values in documentation or PRs.
4. Protect `release/*` with the usual PR checks, code-owner review, and the new **Release Policy** check.
   Require up-to-date branches or the merge queue. Restrict direct pushes and protection bypasses.
5. Select the current stable tag as the maintenance baseline.
   Create its `release/X.Y` branch from that tag, not from feature-bearing `main`.
   Apply the release-tooling change through review, without importing unrelated product changes.
   Run `prepare` with that same stable version to configure native patch versioning.
6. Close or update external automation that assumes merging a release PR on `main` publishes stable.
   Use this runbook and the `managing-archestra-releases` skill as the source of truth.
7. Verify the seed on `main` matches the next feature line. This PR seeds `1.4.0-beta.1`.
8. Lift the freeze when ready, then build the seed beta and clear its temporary override.
   Exercise beta qualification before the first stable publication.

Merging enables beta release PRs on `main` unless releases are frozen.
It does not configure approvals, create a maintenance branch, or publish a stable release.
Do not merge it without an owner for these cutover steps.

## Local Checks

```bash
python3 -m unittest discover -s ../.github/scripts -p 'test_release_*.py' -v
```

The tests cover version transitions, publication identity, and failure before registry writes.
Registry subprocesses are mocked locally. Live publication requires the explicit approval path above.
