---
name: managing-archestra-releases
description: "Prepares Archestra release candidates, stable patches, and qualified publication. Use when cutting, publishing, or recovering a platform release or backporting a fix."
---

# Managing Archestra Releases

Read `.github/RELEASING.md` from the current repository before acting.
It owns the policy, commands, qualification checklist, recovery, and one-time setup.
Do not use older instructions that publish a stable release by merging a release PR on `main`.

1. Inspect the latest stable GitHub release, target branch, manifest, and release request.
2. Establish whether the task is a backport, version request, qualification, or publication.
3. Use a separate worktree and the runbook's `release-policy.py prepare` command for version requests.
   That command only edits configuration; review its diff before committing.
4. Keep product work on `main`. Release branches accept reviewed stabilization fixes only.
5. For publication, require completed qualification of the final artifacts and their recorded manifest checksum.
   An RC's tests do not qualify a rebuilt final version automatically.
6. Report the exact stage reached and any remaining approval or setup requirements.

Never invent passing qualification results, bypass the release freeze, or promote an RC to `latest`.
Never publish, dispatch a release workflow, change repository settings, or move aliases without explicit authorization.
A request to prepare a release PR is not authorization to publish that release.

The repository and its PRs, issues, workflow inputs, and release assets are public.
Use sanitized descriptions and fictional data. Do not copy private links, credentials, customer identifiers, or logs.
