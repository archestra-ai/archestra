# OpenAPPA release update CI

OpenAPPA proposes stable runtime updates in draft PRs on `chore/openappa-v*`
branches. The existing **OpenAPPA Native Tests** job runs the real embedded
runtime and PostgreSQL ledger checks when those PRs are opened by the dedicated
`openappa-archestra-updater[bot]` in this repository. The workflow policy tests in
`test_backport.py` cover these author, branch and repository conditions.

The updater identifies the source release and immutable commit, updates all four
Cargo revisions, regenerates the lockfile and records compilation failures on the
draft for human repair. After a newer draft opens, it closes older updater PRs
and retains their branches. A human reviews the changes, marks the draft ready
and merges through the normal repository process. The updater never approves,
enables auto-merge, queues or merges its PRs. The main ruleset currently requires
zero approving reviews, so human review is a process expectation rather than an
enforced reviewer count.

See OpenAPPA's [updater README](https://github.com/archestra-ai/OpenAPPA/blob/main/.github/scripts/README.md)
for GitHub App setup, release validation and retry instructions.
