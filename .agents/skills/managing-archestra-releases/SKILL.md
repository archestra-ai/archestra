---
name: managing-archestra-releases
description: "Runs rolling release candidates (RCs), stable patches, and complete stable-line cutovers. Use when backporting fixes, cutting or retiring release branches, configuring release protections, testing artifacts, recovering failed runs, or approving releases."
---

# Managing Archestra Releases

Always read `platform/dev/RELEASE.md` first. It is the authoritative release checklist.
Do not assume `release/1.3` is always the active branch. Check current branches, tags, and settings before acting.

This is an execution skill, not only a guide. Use `git`, `gh`, and the GitHub API to complete every applicable step, create the configuration PRs, monitor them through the merge queue, and verify the resulting state. Do not hand routine steps back to the operator.

## Publication Paths

- **RC (`main`):** Merging a release PR on `main` automatically publishes a release candidate (`X.Y.0-rc.N`). It moves only `archestra/platform:latest`; companion and agent images keep `latest` on the stable line.
- **Stable (`release/X.Y`):** Merging a release PR on `release/X.Y` builds stable artifacts. After all builds succeed, the workflow automatically publishes the release and updates the companion and agent images' `latest`. It moves `archestra/platform:latest` only when no newer release is published.

Both channels publish only after a second Engineering member (not whoever merged or started it) approves it in archestra-ai/release-publisher's `stable-release` environment; the release run waits up to 6 hours for it, and an expired wait is retried by re-running the run's failed jobs. Finish qualification before merging a release PR. Starting a new stable branch adds configuration steps and uses the same stable publication pipeline.

## Backporting Fixes

1. Land fixes on `main` first. Fixes on `main` ship automatically in the next RC.
2. Read `.github/backport-targets.json` and apply `backport release/X.Y` labels to the source PR for the configured targets. Labels work before or after merge. **Open Backport PRs** creates separate `cherry-pick -x` PRs; it never merges a release PR or starts publication.
3. Monitor the resulting backport PRs and their checks — including the cross-track migration compatibility check and the released-tag upgrade replay. Review the release-specific diff before queueing them under the user's merge authorization.
4. On conflicts, use the manual `cherry-pick -x` procedure in `platform/dev/RELEASE.md`. Include only necessary fixes; no features, refactors, or schema changes. Never merge `main` into release or candidate branches. A migration backport is only permissible under the prefix rule in `platform/dev/RELEASE.md` (the stable branch's migration history must remain a prefix of main's, matched by SQL content); forward repairs on `main` recover already-shipped gaps and are never a planned backport path.
5. Retry API failures through **Open Backport PRs** workflow dispatch. Existing PRs are not duplicated or reopened, and existing branches are not overwritten. Investigate an unexpected existing branch instead of deleting it.
6. During stable cutover, `stable-line.py cut` creates the `backport release/X.Y` label. `cut` also adds `release/X.Y` Dependabot entries on `main`, and **Move Release Line** opens the PR that moves `.github/backport-targets.json` and drops the previous line's Dependabot entries once `X.Y.0` publishes. The automation's source of truth is the default branch.

## Cutting A New Stable Line End To End

Follow **Cut A New Stable Feature Line** in `platform/dev/RELEASE.md` step by step; it is the only copy of the procedure. `.github/scripts/stable-line.py` (`plan`, `cut`, `handoff`) does the GitHub work. Rules for running it:

- Derive `X.Y`, the previous line, and the next RC from `plan`'s output and live state, never from memory.
- Do not recreate the script's steps through the API. Rulesets belong to Terraform in archestra-ai/infra (`github/org/archestra-release-lines.json`): change them only by a PR to that file, since the next apply reverts any other change.
- Do not run `cut` until the operator explicitly authorizes this stable cut. Present one approval with the RC tag, `X.Y.0`, `release/X.Y`, whether the previous line gets locked, the scoped `do_not_enforce_on_create` exemption if `plan` notes one, and the PRs `cut` opens. That approval covers `cut`, the infra PRs, the configuration PRs, and `handoff`. Merge the `X.Y.0` release PR only when the operator says to publish.
- `cut` needs a repository admin's `gh` login. If it stops, read the error and rerun it; it resumes. A ruleset that did not restore is an incident: have the infra **Terraform apply** workflow re-apply `github/org` before anything else.
- Monitor every PR the cut and its follow-ups open through merge, and confirm rolling RC PRs resume on `main`.

## Safety And Recovery Rules

- **Qualification:** Finish release qualification before merging the release PR. Preserve required CI, image CVE checks, migration checks, the release freeze, and publication ordering guards. Verify the exact saved build artifacts (`release-helm-chart` and `release-image-*`) after automatic publication.
- **Workflow owns publication:** The GitHub Actions workflow handles container image pushes, chart publication, and git tags. Never push release images, publish Helm charts, or update `latest` tags manually.
- **Failed build:** Re-run all jobs in the same workflow run (not only the failed ones: build digests are per-attempt artifacts). It promotes the same queue-scanned archives again while that scan is under 24 hours old.
- **Failed qualification:** Do not merge the release PR. If an unpublished candidate already exists, cancel the run and delete its GitHub draft release only with explicit recovery authorization, but keep its tag. Fix on `main`, backport to `release/X.Y`, set temporary `release-as` to the next patch (for example, `X.Y.1` after a rejected `X.Y.0`), qualify the fix before merging the new release PR, and verify the new artifacts after publication. Never reuse a failed version number.
- **Cutover failure before publication:** If the old line was locked (optional) but the new workflow cannot begin publication, stop. With explicit recovery authorization, cancel the new run, delete its blocking draft but keep its tag, and move the old line back to `mergeQueue` in archestra-ai/infra before accepting old-line changes. When the cut resumes, fix and backport the cause and use the next patch version; never recreate the tagged candidate.
- **Partial publication:** Keep the draft release and tag. With explicit retry authorization, re-run failed jobs in the original run using the saved artifacts; the retry can publish automatically. Never rebuild already published versions or move `latest` backward.
- **Older workflow revisions:** Existing runs and reruns retain their original environment references. Do not approve pending deployments, change live environment protections, delete environments, or retry publication as part of a workflow-only update. Inspect the affected run and obtain explicit authorization for each consequential action.
- **Explicit authorization:** The stable-cut approval covers its stated branch creation, infra and configuration PRs, release PR merge, and scoped ruleset exemption. Approving an older run's deployment, deleting draft releases, and any action outside the approved plan still require explicit authorization.
- **No hidden handoffs:** Create PRs, queue them, monitor checks, configure rules, and verify releases directly. Ask a human only for the stable-cut approval, the go-ahead to publish `X.Y.0`, an older run's deployment approval, or an exceptional recovery decision.
