# Platform Releases
## Release Model

Archestra supports one stable feature line at a time.
`main` produces rolling `X.Y.0-beta.N` releases for explicit customer opt-in.
`release/X.Y` produces `X.Y.0`, then patch releases for stable installations.
The latest stable release remains supported until the next feature line becomes stable.

Beta versions and experimental features are separate controls.
Installing a beta does not enable `ARCHESTRA_BETA`.
Patch releases contain reviewed fixes and no schema or migration-history changes.
A fix that needs a schema change ships in a separately qualified feature release.

## Release-Please Configuration

Release-please configuration is branch-local.
Do not merge stable release metadata back into `main`.

The initial `main` configuration uses native prerelease versioning with:

- `prerelease: true`
- `versioning: prerelease`
- `prerelease-type: beta`
- `release-as: 1.4.0-beta.1`

Merge the release-please PR for `1.4.0-beta.1` and let its artifacts build.
Then remove the consumed `release-as` in a configuration-only PR.
Native prerelease versioning produces later `1.4.0-beta.N` releases.

After `1.4.0` is stable, seed `1.5.0-beta.1` on `main` with a temporary
`release-as` override. Remove it in a configuration-only PR after that seed builds.

To cut `release/1.4`, start from the qualified `platform-v1.4.0-beta.N` tag.
On that branch, set:

- `prerelease: false`
- `versioning: always-bump-patch`
- remove `prerelease-type`
- `release-as: 1.4.0`

Merge the release-please PR for `1.4.0` and qualify its final artifacts.
Remove the stable `release-as` only after `1.4.0` is published.
Native patch versioning then produces `1.4.1`, `1.4.2`, and later patches.
Make these configuration changes manually; there is no release helper script.

## Builds And Publication

The integrated **Release Please** workflow runs on `main` and `release/*`.
It builds every release artifact before its publication job can start.
The same workflow run uploads these immutable artifacts:

- the packaged chart as `release-helm-chart`
- each image reference and digest as `release-image-*`

The publication job downloads those artifacts from the same workflow run.
It promotes image digests without rebuilding images and publishes the saved chart package.
There is no JSON manifest, run-ID input, qualification issue parser, or separate stable workflow.

Releases from `main` use the `beta-release` environment.
This environment has no required reviewer and publishes versioned beta artifacts.
Releases from `release/*` use the `stable-release` environment.
Its required-reviewer gate follows all artifact builds.
Application tests must pass in the protected release PR; final qualification is manual.
Approval therefore applies to the exact artifacts from that workflow run.
GitHub must prevent self-review and allow `stable-release` only from `release/*`, not `main`.

Only stable publication updates floating `latest` aliases.
Production deployments should still pin exact chart versions or image digests.
The workflow uses the existing GitHub Actions secrets; no registry variable is required.

## Backports

Develop fixes on `main` first whenever practical.
Create a short-lived branch from the supported `release/X.Y` branch.
Cherry-pick the fix with `git cherry-pick -x <commit>` and open a PR to `release/X.Y`.
Do not merge `main` into a release branch.

Maintainers review the backport source, diff, conflicts, dependencies, and test evidence.
They also confirm that the patch contains no schema or migration-history changes.
There is no custom release-policy status check.
Keep features, broad refactors, and unrelated dependency updates out of stable patches.

## Qualification

Qualify the final stable build, not only its preceding beta.
The final version changes metadata and is a separate build.

Before approving `stable-release`:

1. Confirm all artifact builds succeeded and the release PR's required tests passed.
2. Download the chart and digest artifacts from that workflow run.
3. Install the chart on a clean disposable environment with `ARCHESTRA_BETA=false`.
4. Verify the running images match the recorded digests.
5. Exercise sign-in, authorization, chat, LLM proxy, MCP tools, and workers.
6. Upgrade a seeded installation from the latest supported stable patch.
7. Verify its users, teams, permissions, conversations, and integrations remain intact.
8. Review migrations, mixed-version behavior, recovery, logs, and resource use.
9. Test both supported image architectures and relevant deployment modes.

Use fictional data during qualification.
Put only sanitized results in the workflow approval comment.
Do not include customer names, credentials, private hosts, private links, or raw logs.
Approval records the maintainer's judgment; it does not replace the checks above.

## Cutover

Before merging the release-process change:

1. Freeze the old release automation and let in-flight publishing finish.
2. Close obsolete release-please PRs against `main`.
3. Configure `beta-release` without approval.
4. Configure `stable-release` with required review and prevented self-review.
5. Restrict `stable-release` deployments to `release/*` branches.
6. Protect `release/*` with normal PR review and required test checks.
7. Create `release/1.3` from `platform-v1.3.50`, not from `main`.
   Apply only the release tooling changes, keep its manifest at `1.3.50`, and configure
   `prerelease: false`, `versioning: always-bump-patch`, and `draft: true`.
   Remove `release-as` and `prerelease-type` on this branch.
8. Confirm `main` is seeded with `1.4.0-beta.1`.
9. Verify registry authentication permits the release branches and the publication
   environment, then lift the freeze when both branches are ready.

Create and protect the environments explicitly before enabling releases.
An automatically created environment has no approval protection.

During a stable cut, pause merges to the old beta release PR.
After stable publication, seed the next beta line and resume beta releases.

## Failure And Recovery

- If a build fails, rerun failed jobs for the same workflow run when safe.
- If artifacts change, run and qualify a new release version.
- If qualification fails, reject or cancel the pending run to unblock the branch.
  Clear any consumed `release-as`, backport the fix, and qualify a new version.
- Never delete or overwrite tags to reuse a version number.
- If publication partially succeeds, inspect registries and GitHub before retrying.
- Never move `latest` backward or rebuild an already published version.

Merging release configuration does not authorize publication.
Stable publication still requires the protected environment approval.
