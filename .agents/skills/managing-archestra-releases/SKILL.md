---
name: managing-archestra-releases
description: "Prepares Archestra beta releases, stable patches, and qualified publication. Use when cutting, publishing, or recovering a platform release or backporting a fix."
---

# Managing Archestra Releases

Read `.github/RELEASING.md` from the current repository before acting.
It owns the policy, commands, qualification checklist, recovery, and one-time setup.
Do not use older instructions that publish a stable release by merging a release PR on `main`.

1. Inspect the latest stable release, target branch, branch-local manifest, configuration, and rolling release PR.
2. Establish whether the task is a backport, train cutover, qualification, or publication.
3. Treat `main` as the rolling `X.Y.0-beta.N` line. Treat `release/X.Y` as the rolling stable patch line.
4. Use `release-policy.py prepare` only for cutovers and clearing temporary `release-as` overrides.
   Clear a beta override with the same current version after its release and tag build successfully.
   Clear a final stable override only after qualification and publication, unless rejecting that build.
5. Never synchronize stable manifests, versions, or changelogs into `main`. It retains beta ancestry.
6. Keep product work on `main`. Release branches accept reviewed stabilization fixes only.
7. Cut a stable branch from the tested beta tag. Freeze main beta merges until the next train is seeded.
8. For publication, require completed qualification of the final artifacts and their recorded manifest checksum.
   A beta release's tests do not qualify a rebuilt final version automatically.
9. Report the exact stage reached and any remaining approval or setup requirements.

Never invent passing qualification results, bypass the release freeze, or promote a beta release to `latest`.
Never publish, dispatch a release workflow, change repository settings, or move aliases without explicit authorization.
A request to prepare a cutover is not authorization to publish that release.

The repository and its PRs, issues, workflow inputs, and release assets are public.
Use sanitized descriptions and fictional data. Do not copy private links, credentials, customer identifiers, or logs.
