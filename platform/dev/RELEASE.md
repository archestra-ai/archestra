# Release Checklist

There are two publication pipelines: beta on `main` and stable on `release/X.Y`.
Stable patches and the first release of a new feature line use the same stable pipeline.
Starting a feature line adds branch/config preparation; "monthly" is a target cadence, not a scheduled job.
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

- [ ] Fix it on `main` first. This is already the beta line; its next release-please PR includes the fix.
  Do not create a separate beta branch or cherry-pick the same fix back onto `main`.
- [ ] Identify the supported stable branch, such as `release/1.3` before `1.4.0` publishes.
  Create a backport PR branch from it and run `git cherry-pick -x <main-fix-sha>`.
- [ ] Open and merge a reviewed, tested PR into that stable branch.
  Include only needed fixes—no features, broad refactors, or schema/migration changes.
- [ ] Review and merge the release-please PR for the next patch, such as `1.3.52`.
- [ ] Complete **Test And Approve Stable** below.

If `release/1.4` was already cut from a beta before the fix landed, it does not inherit later `main` commits.
When that candidate also needs the fix, use a separate `git cherry-pick -x` backport PR targeting it.
The fix then reaches the rolling beta through `main`, and each selected stable/candidate branch through its own backport.
Only one published stable line is supported; an unpublished candidate is not a second production line.
Never merge all of `main` into a stable or candidate branch or copy its release metadata during conflict resolution.

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

`draft: true` controls the GitHub release, not whether the release-please pull request is a draft.
Keep each branch's release metadata separate; do not merge it back into `main`.
We support one stable line. If the next feature release is delayed, keep fixing the old line.

## Test And Approve Stable

The workflow builds first, then waits for **`stable-release` approval** in GitHub Actions.
This applies to both patch releases and the first stable release of a new feature line.
Merging an ordinary backport PR only contributes to the rolling release PR; it does not publish a versioned release.
Merging the release-please PR starts the final build; stable publication still requires approval.
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
- **Failed testing before approval:** reject/cancel the waiting run and delete its GitHub draft, keeping the tag.
  Otherwise later pushes automatically recover the rejected draft.
  Clear any consumed `release-as`, backport the fix, and test a new version.
  Never reuse a version or overwrite its tag.
- **Partial publication:** inspect GitHub and registries before retrying.
  Keep the draft and rerun failed jobs in the original run using its saved artifacts.
  Let that workflow perform uploads, publication, and alias updates; do not perform those steps manually afterward.
  Inspect the retry result. If state remains inconsistent, investigate rather than manually moving `latest` or editing the release.
  Obtain explicit authorization if the retry requires fresh environment approval.
  Never move `latest` backward or rebuild a published version.

A higher stable draft blocks lower stable publication, including while qualification is pending.
Cancel and discard an unapproved candidate before shipping an older-line fix.
Never discard a draft after publication has started; recover that release first.

<details>
<summary>One-time setup — before enabling this process</summary>

- [ ] Freeze old release automation, let publishing finish, and close obsolete release PRs.
- [ ] Create `beta-release` without required approval.
- [ ] Create `stable-release` with required reviewers, prevent self-review, and allow
  deployments only from `release/*`, not `main`. Auto-created environments are unprotected.
- [ ] Protect `release/*` with PR review and required test checks.
- [ ] Create `release/1.3` from the latest published `1.3.x` tag, currently `platform-v1.3.51`.
  Apply only release-tooling changes; keep the manifest at that tag's version. Set `versioning: always-bump-patch`,
  `prerelease: false`, and `draft: true`; remove `release-as` and `prerelease-type`.
- [ ] On `main`, use the beta settings above, but seed `release-as: 1.4.0-beta.1`.
  Remove that override after the first beta builds.
- [ ] Verify registry authentication works for release branches and the publication environment.
- [ ] Lift the freeze when both branches and approvals are ready.

Repository settings, branch creation, and publication require explicit authorization.

</details>
