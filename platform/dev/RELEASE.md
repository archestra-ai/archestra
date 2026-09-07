# Release Checklist

Archestra uses two release pipelines:
- **Beta:** Automatic releases from `main` (for example, `1.4.0-beta.2`).
- **Stable:** Tested and approved releases from `release/X.Y` (for example, `1.3.52` or `1.4.0`).

[Release-please](https://github.com/googleapis/release-please-action#supporting-multiple-release-branches) manages versions and changelogs. GitHub Actions builds the artifacts. Only approved stable releases update `latest`.

## Release A Beta

1. [ ] Open the release-please PR on `main` (for example, `1.4.0-beta.2`).
2. [ ] Review the changelog and confirm checks pass.
3. [ ] Merge the PR and confirm the **Release Please** workflow publishes the beta release.

## Ship A Stable Fix

1. [ ] Land the fix on `main` first. The fix ships automatically in the next beta.
2. [ ] Create a backport branch from the active stable branch (`release/X.Y`):
   ```bash
   git checkout -b backport/fix-name origin/release/X.Y
   git cherry-pick -x <main-commit-sha>
   ```
3. [ ] Open a PR targeting `release/X.Y`. Confirm tests pass and merge.
   - Only include necessary bug fixes. Do not include new features, refactors, or schema migrations.
   - If an unreleased candidate branch (such as `release/1.4`) also needs the fix, repeat step 2 for that candidate branch.
   - Never merge `main` into a release branch.
4. [ ] Merge the generated release-please patch PR on `release/X.Y` (for example, `1.3.52`).
5. [ ] Complete **Test And Approve Stable** below.

## Cut A New Stable Feature Line

1. [ ] Choose a tested beta tag (for example, `platform-v1.4.0-beta.2`).
2. [ ] Create `release/1.4` from that tag (not from `main`):
   ```bash
   git checkout -b release/1.4 platform-v1.4.0-beta.2
   git push origin release/1.4
   ```
3. [ ] Open a PR to `release/1.4` configuring `.github/release-please/release-please-config.json` with the **Stable cut** settings below. Merge it.
4. [ ] Merge the generated `1.4.0` release PR on `release/1.4`, then complete **Test And Approve Stable**.
5. [ ] After `1.4.0` publishes, remove `release-as` from `release/1.4`. Future patches become `1.4.1`, `1.4.2`, etc.
6. [ ] On `main`, open a PR setting the **Next beta** configuration below. Merge it.
7. [ ] After `1.5.0-beta.1` publishes, remove `release-as` from `main`.

### Release Please Configuration

Edit `packages.platform` in `.github/release-please/release-please-config.json`:

| Field | Stable cut (`release/1.4`) | Next beta (`main`) |
| --- | --- | --- |
| `versioning` | `always-bump-patch` | `prerelease` |
| `prerelease` | `false` | `true` |
| `prerelease-type` | Remove field | `beta` |
| `release-as` (temporary) | `1.4.0` | `1.5.0-beta.1` |
| `draft` | `true` | `true` |

`draft: true` creates a draft GitHub release. It does not make the pull request a draft.

## Test And Approve Stable

Merging a release PR on `release/X.Y` builds the artifacts and waits for `stable-release` environment approval. Test these exact artifacts before approving:

1. [ ] Confirm all build jobs in the workflow run completed successfully.
2. [ ] Download the `release-helm-chart` and `release-image-*` workflow artifacts.
3. [ ] Install the saved chart in a test environment with `ARCHESTRA_BETA=false`. Confirm image digests match the build.
4. [ ] Test a clean install and an upgrade from the previous stable version:
   - Verify database migrations, sign-in, chat, MCP tools, LLM proxy, and background workers.
   - Confirm existing data remains intact after upgrade.
5. [ ] Have a second maintainer approve the `stable-release` environment in GitHub Actions.
   - Add a brief, sanitized test summary in the approval comment. Never include sensitive data.
6. [ ] Confirm the workflow publishes the GitHub release, updates Helm charts, and points Docker `latest` to the new version.

## Troubleshooting

- **Build failure:** Inspect the failure and re-run failed jobs in the same workflow run.
- **Testing fails before approval:**
  1. Cancel the workflow run.
  2. Delete the GitHub draft release. Keep the git tag. (Unapproved draft releases block other releases).
  3. Fix the issue on `main`, backport to the release branch, and cut a new version. Never reuse an existing version number.
- **Partial publication:**
  1. Do not publish artifacts or move `latest` manually.
  2. Inspect GitHub releases and container registries.
  3. Re-run failed jobs in the original workflow run using the saved artifacts.
  4. If the retry fails or state remains inconsistent, stop and investigate.

<details>
<summary>One-time setup — initial rollout</summary>

1. [ ] Freeze existing release automation and close obsolete release PRs.
2. [ ] Create GitHub environment `beta-release` without required approvals.
3. [ ] Create GitHub environment `stable-release` with required reviewers, self-review prevention, and deployment restricted to `release/*`.
4. [ ] Add branch protection rules for `release/*`.
5. [ ] Create `release/1.3` from the latest stable tag (`platform-v1.3.51`). Set `versioning: always-bump-patch`, `prerelease: false`, and `draft: true`.
6. [ ] On `main`, configure beta settings with temporary `release-as: 1.4.0-beta.1`.
7. [ ] Confirm registry credentials work for release branches.
8. [ ] Unfreeze releases once branches and environments are ready.

</details>
