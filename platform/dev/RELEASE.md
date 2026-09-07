# Release Checklist

**Pick one:** release a beta, ship a stable fix, or cut the monthly feature release.
[Release-please](https://github.com/googleapis/release-please-action#supporting-multiple-release-branches)
handles versions and changelogs. GitHub Actions handles builds.
Only tested, approved stable releases move `latest`.

## Release A Beta

- [ ] Open the release-please PR targeting `main` (for example, `1.4.0-beta.2`).
- [ ] Review the changelog, wait for PR checks, and merge.
- [ ] Confirm the **Release Please** workflow publishes the beta.

Done. Beta users can deploy it; stable users stay on `1.3.x`.
Installing a beta does not enable the separate `ARCHESTRA_BETA` feature flag.

## Ship A Stable Fix

- [ ] Fix it on `main` first, then cherry-pick it onto a branch from `release/1.3`
  using `git cherry-pick -x <commit>`.
- [ ] Open and merge a reviewed, tested PR into `release/1.3`.
  Include only needed fixes—no features, broad refactors, or schema/migration changes.
- [ ] Review and merge the release-please PR for the next patch, such as `1.3.51`.
- [ ] Complete **Test And Approve Stable** below.

Never merge all of `main` into a stable branch.

## Cut The Monthly Feature Release

- [ ] Pick a tested beta tag, such as `platform-v1.4.0-beta.2`.
  Pause beta release PR merges during the cut.
- [ ] Create `release/1.4` from that tag—not from the latest `main`.
- [ ] In a config-only PR to `release/1.4`, set the stable column below.
- [ ] Review and merge release-please's `1.4.0` PR, then **Test And Approve Stable**.
- [ ] After publication, remove the consumed `release-as` from `release/1.4`.
  Release-please numbers future patch PRs `1.4.1`, `1.4.2`, etc.
- [ ] On `main`, set the next beta column below. Merge its release-please PR,
  wait for `1.5.0-beta.1` to build, then remove the consumed `release-as`.
- [ ] Resume beta releases. Send future stable fixes to `release/1.4`.

Edit `packages.platform` in `.github/release-please/release-please-config.json`:

| Setting | Stable cut (`release/1.4`) | Next beta (`main`) |
| --- | --- | --- |
| `versioning` | `always-bump-patch` | `prerelease` |
| `prerelease` | `false` | `true` |
| `prerelease-type` | Remove | `beta` |
| `release-as` (temporary) | `1.4.0` | `1.5.0-beta.1` |
| `draft` | `true` | `true` |

Keep each branch's release metadata separate; do not merge it back into `main`.
We support one stable line. If the next feature release is delayed, keep fixing the old line.

## Test And Approve Stable

The workflow builds first, then waits for **`stable-release` approval** in GitHub Actions.
Test this final build, not just the preceding beta:

- [ ] Confirm release PR checks and all artifact builds passed.
- [ ] Download `release-helm-chart` and `release-image-*` from that workflow run.
  Install the saved chart in a disposable environment with `ARCHESTRA_BETA=false`;
  confirm the running image digests match the saved references.
- [ ] Check a fresh install and an upgrade from the latest stable patch using fictional data.
  Exercise sign-in, permissions, chat, LLM proxy, MCP tools, workers, and changed behavior.
  Confirm existing data and access restrictions survive the upgrade.
- [ ] Check migrations/recovery, logs, and resource use on supported architectures and relevant deployment modes.
- [ ] Have another maintainer approve `stable-release`, recording a short, sanitized test summary.
  Never include customer details, secrets, private links, or raw logs.
- [ ] Confirm the workflow publishes the stable release and chart and updates `latest`.

Approval publishes the saved chart and image digests without rebuilding.
Production users should still pin exact versions or digests.

## If Something Fails

- **Build failure:** inspect it and rerun failed jobs in the same run when safe.
- **Failed testing:** reject/cancel the waiting run, clear any consumed `release-as`,
  backport the fix, and test a new version. Never reuse a version or overwrite its tag.
- **Partial publication:** inspect GitHub and registries before retrying.
  Never move `latest` backward or rebuild a published version.

<details>
<summary>One-time setup — before enabling this process</summary>

- [ ] Freeze old release automation, let publishing finish, and close obsolete release PRs.
- [ ] Create `beta-release` without required approval.
- [ ] Create `stable-release` with required reviewers, prevent self-review, and allow
  deployments only from `release/*`, not `main`. Auto-created environments are unprotected.
- [ ] Protect `release/*` with PR review and required test checks.
- [ ] Create `release/1.3` from `platform-v1.3.50`. Apply only release-tooling changes;
  keep its manifest at `1.3.50`. Set `versioning: always-bump-patch`,
  `prerelease: false`, and `draft: true`; remove `release-as` and `prerelease-type`.
- [ ] On `main`, use the beta settings above, but seed `release-as: 1.4.0-beta.1`.
  Remove that override after the first beta builds.
- [ ] Verify registry authentication works for release branches and the publication environment.
- [ ] Lift the freeze when both branches and approvals are ready.

Repository settings, branch creation, and publication require explicit authorization.

</details>
