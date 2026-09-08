---
name: managing-archestra-releases
description: "Guides rolling beta releases, stable patches, and new stable feature branches. Use when backporting fixes, cutting release branches, testing artifacts, recovering failed runs, or approving releases."
---

# Managing Archestra Releases

Always read `platform/dev/RELEASE.md` first. It is the authoritative release checklist.
Do not assume `release/1.3` is always the active branch. Check current branches, tags, and settings before acting.

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

## Cutting A New Stable Line

1. Create `release/X.Y` from a verified beta tag, never directly from `main`.
2. Configure `.github/release-please/release-please-config.json` with temporary `release-as: X.Y.0` and `draft: true`.
3. Test and qualify the actual release build artifacts. Do not simply retag beta images.
4. After publication, remove `release-as` from `release/X.Y`.
5. After `1.4.0` ships, start `1.5.0-beta.1` on `main` with a temporary `release-as`. Remove the override after the first beta builds.

For initial setup from stable `1.3.x`, start `1.4.0-beta.1`, not `1.5.0-beta.1`.

## Safety And Recovery Rules

- **Testing gate:** Verify the exact saved build artifacts (`release-helm-chart` and `release-image-*`) before approving `stable-release`.
- **Workflow owns publication:** The GitHub Actions workflow handles container image pushes, chart publication, and git tags. Never push release images, publish Helm charts, or update `latest` tags manually.
- **Failed build:** Re-run failed jobs in the same workflow run.
- **Failed qualification:** If testing fails before approval, cancel the run and delete the GitHub draft release. Keep the git tag. Never reuse a failed version number.
- **Partial publication:** Keep the draft release and tag. Re-run failed jobs in the original run using the saved artifacts. Never rebuild already published versions or move `latest` backward.
- **Fresh approval:** A rerun or new candidate needs fresh artifact verification and explicit authorization before any new `stable-release` approval.
- **Explicit authorization:** Merging release PRs, approving release environments, deleting draft releases, and modifying repository settings are consequential. Always obtain explicit user authorization before performing these actions.
