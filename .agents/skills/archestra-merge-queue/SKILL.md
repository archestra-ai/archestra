---
name: archestra-merge-queue
description: Use when asked to add an Archestra PR to the merge queue, monitor it through merge, or diagnose and repair merge-group CI failures. Own the requested PR until merged or an actionable blocker; opening a PR alone does not start this workflow.
---

# Own the merge queue request

A request to add a PR to the merge queue is an execution task. Enqueue it,
monitor it, and handle failures until GitHub confirms it merged or there is an
actionable blocker. Queue entry, auto-merge enabled, and green PR checks are
intermediate states, not completion. Do not hand routine diagnosis, fixes, or
requeueing back to the developer.

Read [GitHub commands and CI map](references/github-and-ci.md) before acting.
Use the live rules for the actual base branch and the workflows at the tested
commit; the reference describes current `main`, not a permanent required-check
list. Ordinary PR pushes skip most expensive jobs. Those skipped statuses
allow queue entry but do not validate the combined merge-group commit.

## Scope and entry

1. Resolve the exact repository and PR from the request. Record its URL/number,
   base branch, head repository/owner/branch, and current `headRefOid`. Never
   select a PR implicitly from whichever branch happens to be checked out.
2. Apply the user's session authorization and repository instructions. A queue
   request authorizes enqueueing that PR and its eventual queue merge. Carry
   forward already-granted permission to fix, commit, push, and requeue it;
   do not ask again. This skill grants no permissions itself. If explicit
   publication approval required by `platform/AGENTS.md` is still missing,
   prepare and locally verify a concrete patch before asking for that missing
   approval. A request only to create a draft PR does not authorize queue entry.
3. Inspect the PR diff/history, local worktree ownership and WIP, current PR
   policy checks, reviews, draft state, and live branch rules. Preserve other
   developers' branches, worktrees, processes, and uncommitted work. Use a
   dedicated worktree for repairs; read applicable instructions before editing.
   A missing merge-queue rule is a blocker: the same CLI command could otherwise
   merge directly. Do not bypass the queue with `--admin`, change rules/secrets/
   runner variables, approve your own PR, or enqueue other PRs.
4. Run relevant local checks using `archestra-dev-testing` and the skills for
   the changed domain. For platform work, run from `platform/` using `pnpm`.
   Address fixable PR policy failures. Missing reviews, access, a release freeze,
   or an intentionally draft PR need a concrete blocker report, not a bypass.
5. Refresh the PR head immediately before enqueueing and use explicit PR/repo
   arguments with `--match-head-commit`. If it changed, inspect the new diff and
   revalidate affected work first. Read back queue membership or auto-merge
   state after the command; its successful exit is not evidence of a merge.

## Monitor the current attempt

Poll PR state and queue membership about every 30–60 seconds while active,
using interruptible waits and concise updates when progress changes. Do not end
the task just because checks are pending or another group is ahead of it.
Honor cancellation immediately; do not create a background/scheduled monitor
or leave one running unless the user requests it.

Keep these identities separate:

- **PR head**: `headRefOid`, the branch commit to verify before pushing/enqueueing.
- **Queue head/base**: `mergeQueueEntry.headCommit.oid` and `baseCommit.oid`, the
  synthetic combination tested by `merge_group`; the head can initially be null.
- **Run attempt**: workflow run ID, `head_sha`, event, and `run_attempt`, plus
  job IDs and their URLs. Fetch all runs/jobs/check pages for the exact queue SHA.

Snapshot the queue entry ID, enqueue time and synthetic SHAs on each poll.
Re-read membership after collecting checks. A different PR head, entry, or queue
SHA invalidates the earlier snapshot; rediscover the current attempt instead
of applying old results to it. Retain failed-attempt evidence even after eviction.
Do not infer membership from a `gh-readonly-queue/.../pr-N-...` name or select
the newest repository run: stacked groups can contain other PRs.

Use PR checks for queue-entry policy, then inspect checks/statuses and every
workflow/job on the current synthetic SHA, including non-required jobs. Match
required contexts and their integration IDs against live rules. Missing,
pending, cancelled, timed-out, or unexpectedly skipped checks need investigation;
a skipped twin or successful aggregate cannot erase another failed job. For
aggregate gates, inspect their underlying shards/test legs and input-detection
results. A legitimate conditional skip must be established from the workflow
and successful gate, not assumed from a green PR rollup.

If auto-merge is enabled but membership is absent, keep watching PR policy and
eligibility. If a queue entry disappears, first refresh PR state: it may have
merged. Otherwise inspect the queue removal reason, actor/time, last queue SHA,
and logs. Distinguish CI eviction, conflicts, timeout, superseded group, and
deliberate human removal; do not automatically undo someone else's removal.

## Diagnose, repair, verify, requeue

For **any failed queue job**, capture the complete failure picture before
changing code: exact SHA/run/attempt/job, failed steps, logs and relevant test
artifacts. Follow aggregate failures to the originating jobs. Inspect each
independent failure, not just the first red gate. If the PR has already merged,
report remaining failures and obtain scope for any follow-up PR.

Classify the evidence and act:

| Evidence | Action |
| --- | --- |
| Reproducible code, lint, build, migration, security, or test failure | Reproduce the failing command/scenario locally, patch the cause, and verify the fix. |
| Failure only on the combined queue commit | Reproduce that recorded synthetic SHA in a disposable detached worktree; compare with the target PR plus current base to isolate the interaction. Patch only the authorized PR. A cause in another PR or base that cannot be fixed within scope is a blocker with evidence. |
| Test intermittency | Reproduce/investigate the failed scenario, fix the race or isolation issue, and run enough focused repetitions to exercise it. A later green run alone does not establish a fix. |
| Evidenced infrastructure/transient failure | Attempt local reproduction where meaningful and record its limits. Verify the outage/failover recovered before one justified retry or requeue for that failure signature. Repeated failure without a new diagnosis/remedy is a blocker. Do not invent a source patch for a runner outage. |
| Cancelled/superseded group | Inspect current entry and run identity; follow its replacement. Cancellation of obsolete runs is not a failure of the current head. An unexplained active cancellation/timeout requires diagnosis. |
| Conflict/queue eviction | Fetch the current base and inspect the removal reason. Resolve conflicts on the authorized PR branch, preserving its intent, then rerun affected checks. Prefer an ordinary merge commit where allowed; never amend or force-push without explicit authorization. Requeue only after the cause is resolved. |
| Permissions, required approval, unavailable environment/logs, or out-of-scope change | Complete safe independent diagnosis, then report precisely what access, decision, or remediation is needed. Do not claim local reproduction or validation happened. |

For a repair, run the original failing check/scenario locally before and after
the patch when the environment permits; pin a behavior regression at the right
test level. Then run the affected suite and relevant lint/type/build checks from
the workflow and domain skills. If exact reproduction is unavailable, document
what was tried and the mismatch; do not substitute an unrelated passing test.
No blind retry loops, removed assertions, skipped tests, weakened gates, or
required-check renames to obtain green status.

Review the final diff and commit a focused fix. Re-read the remote PR head and
verify it still matches the commit the repair was based on before publishing;
inspect unexpected collaborator changes rather than overwriting them. Push
explicitly to the PR's head repository and branch, confirm GitHub's new
`headRefOid` equals the verified local commit, and recheck PR policy. Use the
same guarded queue command for the new head, then resume monitoring its new
synthetic SHA. Fixable failure is a loop through local verification, publication,
and monitoring, not a stopping point.

## Completion and handoff

Confirm `state: MERGED` with `mergedAt` and `mergeCommit.oid` on the requested
PR. Report its URL, merge commit, and any material unresolved non-gating failure.
Do not equate a completed workflow or an empty queue with a merged PR.

For a blocker or user cancellation, report the PR/head and queue SHA, relevant
run/job links, diagnosis, local reproduction/checks attempted, any pushed fix,
current queue/auto-merge state, and the specific next action needed. Do not
promise monitoring after the turn ends. Stop mutations on cancellation; if
the user explicitly asks to remove the PR or disable auto-merge, perform that
requested action and read back its state.
