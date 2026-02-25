# Release Process

This document explains how releases work in Archestra.

## Overview

Archestra uses [Release Please](https://github.com/googleapis/release-please) to automate versioning and releases. The process is:

1. Merge changes to `main`
2. Release Please automatically creates/updates a release PR
3. When the release PR is merged, a new version is published

## Standard Release Flow

### 1. Merge PR to `main`

Create a PR targeting `main` with your changes. Title of PR should follow [Conventional Commits](https://www.conventionalcommits.org/). Once you are ready, click Merge. You don't need to wait for all the checks to complete, they are optional on PR. Your PR will be put on Merge Queue where the same checks must pass in order for your PR to be merged.

When your PR is merged to `main`:
- A Docker image is built and pushed to Google Artifact Registry
- The image is automatically deployed to the staging environment
- You can verify your changes at `https://frontend.archestra.dev`

### 2. Merge Release Please PR

After merging to `main`, Release Please will create a new PR (or update an existing one) titled "chore(main): release platform vX.Y.Z". It will commit the following additional changes:
- Update version numbers in `package.json` files
- Bump version in `openapi.json`
- Generate/update `CHANGELOG.md`

[Example of PR](https://github.com/archestra-ai/archestra/pull/2143)

Merge it.

### 3. Done 🎉

This triggers:
- GitHub Release creation with the new tag
- Multi-arch Docker image build and push to Docker Hub
- Helm chart publication

## Hotfix Flow

Use this when you need to patch an already-released version without including unreleased changes from `main`.

### 1. Create a Release Branch

Create a branch from the tag you want to patch, so we can merge hotfix into it later and make a hotfix release:

```bash
# Example: patching platform-v1.0.22
git fetch --tags
git checkout -b release/v1.0.22 platform-v1.0.22
git push origin release/v1.0.22
```

### 2. Apply the Fix

Create a PR targeting your `release/v1.0.22` branch:

```bash
git checkout -b hotfix/fix-critical-bug release/v1.0.22
```
```
# make your fix
git commit -m "fix: resolve critical authentication issue"
```
```
# Alternatively cherry-pick commits from main or from PR
# NOTE: Make sure that the PR's branch is not deleted, copy commit SHA
git cherry-pick <commit-sha>
```
```
git push origin hotfix/fix-critical-bug
# create PR targeting release/v1.0.22, get review, merge
```

### 3. Release the Hotfix

When you merge to `release/v1.0.22`:
- Release Please creates a PR for `v1.0.23` targeting the release branch
- Merge this PR to create the hotfix release

### 4. Backport to Main

After releasing the hotfix, apply the fix to `main`:

```bash
# Checkout and pull latest `main`
git checkout main
git pull origin main

# Cherry-pick specific commits
git cherry-pick <commit-sha>

# Push to `main`
git push origin main
```

### 5. IMPORTANT! Bump the version on `main` using the `release-as` directive:

```bash
git checkout main
git pull origin main
git commit -m "chore(release): bump version" -m "release-as: X.Y.Z" --allow-empty
git push origin main
```
(alternatively create PR with this empty commit and merge to `main`)
Replace X.Y.Z with a version higher than the hotfix you just released (e.g., if hotfix was v1.0.23, use v1.0.24)

Now the version of existing release-please PR for `main` will be bumped

## Quick Reference

### Release a New Version

1. Merge your feature PRs to main
2. Review and merge the Release Please PR


### Release a Hotfix

1. Create release branch from tag
```bash
git checkout -b release/v1.0.22 v1.0.22
git push origin release/v1.0.22
```
2. Create PR targeting `release/v1.0.22` branch
3. Merge the PR
4. Find the Release Please PR that appears and merge it
5. Backport to main
```bash
git checkout main && git cherry-pick <sha> && git push
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

### Staging deployment failed

Check the "On commits to main" workflow for errors. Common issues:
- Docker build failures
- Kubernetes deployment issues
- Secret configuration problems
