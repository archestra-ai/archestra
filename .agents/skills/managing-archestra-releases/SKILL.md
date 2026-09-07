---
name: managing-archestra-releases
description: "Guides Archestra beta, stable, and patch releases. Use when cutting a release branch, backporting a fix, qualifying artifacts, or approving publication."
---

# Managing Archestra Releases
Read `platform/dev/RELEASE.md` before acting; it is the release source of truth.
Inspect the target branch, latest stable tag, release-please configuration, and release PR.
Keep rolling betas on `main` and stable patches on `release/X.Y`.
Make cutover overrides directly in release-please configuration; do not invent a helper.
Cut stable branches from a qualified beta tag and keep schema changes out of patches.
Require passing release PR tests and qualification of the workflow's exact saved artifacts before approval.
Use `beta-release` for `main` and protected `stable-release` for `release/*`.
Record only sanitized evidence in the environment approval comment.
Never publish, move `latest`, or change repository settings without explicit authorization.
