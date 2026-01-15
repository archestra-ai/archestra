# Release Process

This document explains how releases work in Archestra.

## Overview

Archestra uses [Release Please](https://github.com/googleapis/release-please) to automate versioning and releases. The process is:

1. Merge changes to `main`
2. Release Please automatically creates/updates a release PR
3. When the release PR is merged, a new version is published

## Standard Release Flow

### 1. Develop and Merge

Create a PR targeting `main` with your changes. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:

- `feat:` - New feature (bumps minor version)
- `fix:` - Bug fix (bumps patch version)
- `feat!:` or `fix!:` - Breaking change (bumps major version)
- `docs:`, `chore:`, `ci:`, `test:` - No version bump

Example:
```bash
git checkout -b feature/my-feature
# make changes
git commit -m "feat: add new dashboard widget"
git push origin feature/my-feature
# create PR, get review, merge
```

### 2. Automatic Staging Deployment

When your PR is merged to `main`:
- A Docker image is built and pushed to Google Artifact Registry
- The image is automatically deployed to the staging environment
- You can verify your changes at `https://frontend.archestra.dev`

### 3. Release Please PR

After merging to `main`, Release Please will:
- Create a new PR (or update an existing one) titled "chore(main): release platform vX.Y.Z"
- Update version numbers in `package.json` files
- Generate/update `CHANGELOG.md`

### 4. Create the Release

When you're ready to release:
1. Review the Release Please PR
2. Merge it

This triggers:
- GitHub Release creation with the new tag
- Multi-arch Docker image build and push to Docker Hub
- Helm chart publication

## Hotfix Flow

Use this when you need to patch an already-released version without including unreleased changes from `main`.

### 1. Create a Release Branch

Create a branch from the tag you want to patch:

```bash
# Example: patching v1.0.22
git fetch --tags
git checkout -b release/v1.0.22 v1.0.22
git push origin release/v1.0.22
```

### 2. Apply the Fix

Create a PR targeting your `release/v1.0.22` branch:

```bash
git checkout -b hotfix/fix-critical-bug release/v1.0.22
# make your fix
git commit -m "fix: resolve critical authentication issue"
git push origin hotfix/fix-critical-bug
# create PR targeting release/v1.0.22, get review, merge
```

### 3. Release the Hotfix

When you merge to `release/v1.0.22`:
- Release Please creates a PR for `v1.0.23` targeting the release branch
- Merge this PR to create the hotfix release

**Important:** If there's already a release-please PR on `main` targeting the same version (v1.0.23), you'll need to resolve the version clash after releasing the hotfix. See [Version Clash](#version-clash-after-hotfix) in Troubleshooting.

### 4. Backport to Main

After releasing the hotfix, apply the fix to `main`:

```bash
git checkout main
git pull origin main

# Option A: Cherry-pick specific commits
git cherry-pick <commit-sha>

# Option B: Merge the release branch
git merge release/v1.0.22

git push origin main
```

### 5. Cleanup

Delete the release branch after the hotfix is released and backported:

```bash
git push origin --delete release/v1.0.22
```

## Quick Reference

### Release a New Version

```bash
# 1. Merge your feature PRs to main
# 2. Wait for Release Please PR to appear
# 3. Review and merge the Release Please PR
# Done! Check GitHub Releases for the new version.
```

### Release a Hotfix

```bash
# 1. Create release branch from tag
git checkout -b release/v1.0.22 v1.0.22
git push origin release/v1.0.22

# 2. Create and merge fix PR targeting release/v1.0.22

# 3. Merge the Release Please PR that appears

# 4. Backport to main
git checkout main && git cherry-pick <sha> && git push

# 5. Delete release branch
git push origin --delete release/v1.0.22
```

## Release Freeze

To temporarily prevent releases (e.g., during a critical period):

1. Go to Actions > "Toggle Release Freeze" workflow
2. Run the workflow to toggle the freeze on/off

When frozen, Release Please PRs cannot be merged.

## Troubleshooting

### Release Please PR not appearing

- Ensure your commits use conventional commit format
- Check the "Release Please" workflow run for errors
- Commits with `chore:`, `ci:`, `docs:`, `test:` prefixes don't trigger releases

### Version not bumping as expected

Release Please determines version bumps from commit messages:
- `fix:` → patch bump (1.0.0 → 1.0.1)
- `feat:` → minor bump (1.0.0 → 1.1.0)
- `feat!:` or `BREAKING CHANGE:` → major bump (1.0.0 → 2.0.0)

### Staging deployment failed

Check the "On commits to main" workflow for errors. Common issues:
- Docker build failures
- Kubernetes deployment issues
- Secret configuration problems

### Version Clash After Hotfix

**Scenario:** You released a hotfix (e.g., v1.0.23) from a `release/*` branch, but `main` already has a release-please PR targeting the same version.

**Symptom:** The "Version Clash Check" CI job fails on the release-please PR for `main`.

**Solution:** Bump the version on `main` using the `release-as` directive:

```bash
git checkout main
git pull origin main
git commit -m "chore(release): bump version" -m "release-as: 1.0.24" --allow-empty
git push origin main
```

This creates an empty commit that tells Release Please to target v1.0.24 instead. The release-please PR will automatically update.

**Prevention:** Before merging any release-please PR, check that the target version hasn't already been used. The CI check does this automatically, but if you're releasing a hotfix, be aware that you may need to bump the version on `main` afterwards.
