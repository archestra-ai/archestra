---
name: managing-archestra-releases
description: "Guides rolling beta publication, stable patches, and new stable feature lines. Use when backporting main-branch fixes, cutting a candidate branch, qualifying artifacts, recovering publication, or approving a release."
---

# Managing Archestra Releases

Read `platform/dev/RELEASE.md` before acting; it is the release source of truth.
Inspect the current branch, supported stable line, latest stable tag, release config/manifest,
release PR, workflow run, and environment protections. Do not assume `release/1.3` remains supported.

## Choose The Publication Path

- `main` is the rolling beta line. Merging its release-please PR builds and publishes a beta
  through `beta-release`, without moving `latest`. Ordinary feature/fix PRs do not themselves publish a versioned release.
- Every `release/X.Y` uses the same stable pipeline, for both patches and its first feature release.
  Merging its release-please PR builds the final artifacts; it does not publish them yet.
  Qualify those artifacts, then approve protected `stable-release` to publish the saved chart/digests and update `latest`.
- Starting a new feature line adds branch/config preparation, not another publication pipeline.
  "Monthly" is the intended cadence, not a scheduled job.

## Propagate Fixes

- Land the fix on `main` first. It already belongs to the beta line and will ship with the next beta release PR.
  Do not invent a separate beta branch or cherry-pick a commit back onto `main` when it is already there.
- For the supported stable line, create a backport PR branch from `release/X.Y` and run `git cherry-pick -x <main-fix-sha>`.
  Review the diff for unrelated features, broad refactors, or schema/migration changes; exclude them from patches.
- If an already-cut candidate branch also needs a later fix from `main`, prepare a separate selective backport PR for it.
  Do not merge all of `main` into stable or candidate branches. A candidate is not a second supported production line.
- Resolve backport conflicts for each target without importing its release metadata from `main`.
  Merge reviewed backport PRs before their release-please PRs. Both production and candidate releases use stable qualification.

## Cut A New Stable Line

Cut `release/X.Y` from a tested beta tag, not the latest `main`.
Use a config-only PR with the checklist's stable settings and a temporary final-version `release-as`.
Qualify a fresh final stable build; do not merely relabel beta artifacts.
Remove the consumed stable override after publication. Then move maintenance to the new stable line
and seed the next beta line on `main`; remove its override after the first beta builds.
Use native release-please configuration, not a custom version helper or manual manifest bump.
`draft: true` makes the GitHub release a draft; it does not make the release-please pull request a draft.

## Approval And Recovery

Require passing release PR checks and qualification of the exact saved final artifacts before stable approval.
Verify required reviewers, prevented self-review, and `release/*` deployment restrictions;
an auto-created environment is not a protected approval gate. Record only sanitized qualification evidence.
Retry failed jobs in the original run using its saved artifacts after partial publication.
Use workflow retry/approval controls; the workflow owns chart upload, release publication, and alias updates.
Do not add manual release edits or `latest` movements after a retry or approval.
Inspect completion before doing anything else. If state remains inconsistent, stop and investigate instead of publishing manually.
If a retry requires fresh approval, obtain explicit approval authorization rather than assuming it from permission to retry.
Never rebuild a partially published version, discard its draft, overwrite its tag, or move `latest` backward.
For a rejected candidate that never started publication, cancel its run and delete only the draft, retaining its tag.
Otherwise later pushes recover that rejected draft. A higher stable draft also blocks lower stable publication.

Treat release-PR merges, environment approvals, draft deletion, and repository-setting changes as consequential.
Do not perform them without explicit authorization. Preparing a backport or release plan is not authorization to publish.
