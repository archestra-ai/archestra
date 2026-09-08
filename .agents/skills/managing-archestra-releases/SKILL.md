---
name: managing-archestra-releases
description: "Runs rolling beta releases, stable patches, and complete stable-line cutovers. Use when backporting fixes, cutting or retiring release branches, configuring release protections, testing artifacts, recovering failed runs, or approving releases."
---

# Managing Archestra Releases

Always read `platform/dev/RELEASE.md` first. It is the authoritative release checklist.
Do not assume `release/1.3` is always the active branch. Check current branches, tags, and settings before acting.

This is an execution skill, not only a guide. Use `git`, `gh`, and the GitHub API to complete every applicable step, create the configuration PRs, monitor them through the merge queue, and verify the resulting state. Do not hand routine steps back to the operator.

## Publication Paths

- **Beta (`main`):** Merging a release PR on `main` automatically publishes a beta release. It does not move the Docker `latest` tag.
- **Stable (`release/X.Y`):** Merging a release PR on `release/X.Y` builds stable artifacts. Publication pauses for manual `stable-release` environment approval. Once approved, the workflow publishes the release and updates `latest`.

Starting a new stable branch adds configuration steps. It uses the same stable publication pipeline.

## Backporting Fixes

1. Land fixes on `main` first. Fixes on `main` ship automatically in the next beta release.
2. Backport fixes to the active stable branch (`release/X.Y`):
   - Branch from `origin/release/X.Y`.
   - Use `git cherry-pick -x <main-commit-sha>`.
   - Include only necessary bug fixes. Do not include features, refactors, or schema changes.
3. If an unreleased candidate branch also needs the fix, open a separate backport PR targeting that branch.
4. Never merge `main` directly into `release/X.Y` or candidate branches.

## Cutting A New Stable Line End To End

Derive `X.Y`, the previous stable line, and the next beta line from live branches, tags, releases, and Release Please manifests. Never substitute a remembered version.

### 1. Preflight And Stable-Cut Approval

1. Fetch branches and tags. Confirm the selected `platform-vX.Y.0-beta.N` is a published prerelease, points to a commit on `main`, and passed the agreed qualification.
2. Confirm `release/X.Y` and `platform-vX.Y.0` do not exist, no conflicting draft release exists, releases are not frozen, and the current stable release is older than `X.Y.0`.
3. Inspect the live `release/*` core ruleset, the exact-branch merge-queue ruleset for the active stable line, and the `stable-release` environment. Fail closed if they cannot be read.
4. Present one approval containing the beta tag, new stable version and branch, previous line that will become EOL, planned repository-setting changes, and the PRs that will be created and merged. Do not create the branch, modify settings, or merge a release PR until the operator explicitly authorizes this stable cut.

That authorization covers the mechanical preparation and release-PR merge described below. It does not replace the independent `stable-release` environment approval after artifact qualification.

### 2. Create And Protect The Branch

1. Inspect `do_not_enforce_on_create` in the `release/*` core ruleset's required checks. If it is false and the release automation's bypass identity cannot create the branch, update only that field to true under the stable-cut authorization. Preserve the complete original ruleset payload for restoration.
2. Create `release/X.Y` at the exact verified beta tag and push it. Never create it from `main`. Immediately restore the original core ruleset and read it back; do not leave branch creation exempted.
3. Confirm the repository's active `release/*` core ruleset applies to the new branch and matches `main` for pull requests, required checks, deletion, non-fast-forward protection, and bypass actors.
4. Before any PR can merge, create an exact-branch merge-queue ruleset for `release/X.Y`. GitHub rejects merge queues on wildcard rulesets. Clone the live active stable line's queue rule and bypass actors through the rulesets API, changing only its name and included ref. Read the created ruleset back and compare its queue parameters with `main`.
5. Verify `stable-release` has required reviewers, `prevent_self_review: true`, and `can_admins_bypass: false`. Configure these fields through the environments API as part of the authorized setting changes; GitHub accepts `can_admins_bypass` in the update payload although its public REST schema omits the field. If GitHub rejects it, change the environment setting with browser automation instead of asking the operator to click through the UI. Read the environment back and never continue with a bypassable or unprotected stable environment.
6. Replace wildcard deployment access with exact custom branch policies. During candidate qualification, allow only the current stable branch and `release/X.Y`; after cutover, allow only `release/X.Y`.

Do not hard-code ruleset IDs, check names, integration IDs, reviewer IDs, or queue parameters in the skill. Discover and clone current settings so future changes on `main` are preserved. If no unambiguous current setting or reviewer team can be derived, include that choice in the stable-cut approval instead of guessing.

### 3. Prepare And Cut `X.Y.0`

1. Branch from `release/X.Y` and change `packages.platform` in `.github/release-please/release-please-config.json` to:
   - `versioning: always-bump-patch`
   - `prerelease: false`
   - remove `prerelease-type`
   - temporary `release-as: X.Y.0`
   - `draft: true`
2. Open the release-configuration PR against `release/X.Y`, monitor its required checks, and merge it through the new queue.
3. Inventory open PRs against the previous stable line. Recreate every still-required fix that already landed on `main` as a `cherry-pick -x` backport to `release/X.Y` and merge it before the initial release. Wait for Release Please to update the release PR.
4. Wait for Release Please to create or update the `X.Y.0` PR. Verify its base, manifest version, changelog, and release configuration, then merge it through the queue under the stable-cut authorization.
5. Wait for every build job. Download and qualify the exact `release-helm-chart` and `release-image-*` artifacts. Never qualify retagged beta artifacts.

### 4. Commit The Cutover And Publish

Only continue after the candidate artifacts pass qualification. The old line stays supported until this point.

1. Confirm no previous-line release workflow is running or waiting for approval. Close its remaining PRs with an EOL explanation, including its generated release PR.
2. Remove `release/A.B` from `stable-release` deployment policies. Delete its exact merge-queue ruleset, then create an active exact-branch EOL ruleset with an `update` rule, no bypass actors, and `update_allows_fetch_and_merge: false`. Keep the branch, tags, releases, images, and charts for reproducibility.
3. Read everything back. Verify `release/A.B` rejects all updates, `release/X.Y` has its queue, and only `release/X.Y` can enter `stable-release`.
4. A different eligible maintainer approves the waiting `stable-release` deployment after reviewing the sanitized test summary. Confirm publication completed: the GitHub release is stable and latest, the chart exists, every image version exists, and all `latest` image tags resolve to the approved digests.
5. Open and queue a PR on `release/X.Y` that removes only the temporary `release-as`. Leave `always-bump-patch`, `prerelease: false`, and `draft: true`. Future fixes now produce `X.Y.1`, `X.Y.2`, and so on.
6. Report that `X.Y` is the sole supported stable line.

### 5. Start The Next Beta Line

The next beta is a separate consequential release. Stop and present a second approval with the intended `X.(Y+1).0-beta.1` version, current `main` SHA, configuration PR, and generated release PR. Do not change `main` or merge the beta release PR until explicitly authorized.

After authorization:

1. Open a PR to `main` setting `packages.platform` to `versioning: prerelease`, `prerelease: true`, `prerelease-type: beta`, temporary `release-as: X.(Y+1).0-beta.1`, and `draft: true`.
2. Merge it through the `main` queue. Wait for and verify the generated `X.(Y+1).0-beta.1` release PR, then merge it through the queue.
3. Confirm the beta release and versioned artifacts published and Docker `latest` did not move.
4. Open and queue a cleanup PR on `main` removing only `release-as`. Confirm Release Please resumes its rolling beta PR for `.2` and later.

The initial migration from stable `1.3.x` started `1.4.0-beta.1`; do not use that historical exception when deriving later versions.

## Safety And Recovery Rules

- **Testing gate:** Verify the exact saved build artifacts (`release-helm-chart` and `release-image-*`) before approving `stable-release`.
- **Workflow owns publication:** The GitHub Actions workflow handles container image pushes, chart publication, and git tags. Never push release images, publish Helm charts, or update `latest` tags manually.
- **Failed build:** Re-run failed jobs in the same workflow run.
- **Failed qualification:** Before the old-line lock, cancel the run and delete the GitHub draft release with authorization, but keep its tag. Fix on `main`, backport to `release/X.Y`, set temporary `release-as` to the next patch (for example, `X.Y.1` after a rejected `X.Y.0`), merge the new release PR, and qualify the new artifacts. Never reuse a failed version number.
- **Cutover failure before publication:** If the old line was locked but the new deployment was rejected or cannot begin publication, stop. With explicit recovery authorization, cancel the new run, delete its blocking draft but keep its tag, restore the old exact deployment policy and merge queue, and remove its EOL rule before accepting old-line changes. When the cut resumes, fix and backport the cause and use the next patch version; never recreate the tagged candidate.
- **Partial publication:** Keep the draft release and tag. Re-run failed jobs in the original run using the saved artifacts. Never rebuild already published versions or move `latest` backward.
- **Fresh approval:** A rerun or new candidate needs fresh artifact verification and explicit authorization before any new `stable-release` approval.
- **Explicit authorization:** Stable and next-beta cut approvals may cover their stated branch pushes, configuration PRs, release PR merges, and repository-setting changes. Approving release environments, deleting draft releases, and any action outside the approved plan still require explicit authorization.
- **No hidden handoffs:** Create PRs, queue them, monitor checks, configure rules, and verify releases directly. Ask a human only for the two cut approvals, the independent stable-environment approval, a reviewer identity that cannot be derived safely, or an exceptional recovery decision.
