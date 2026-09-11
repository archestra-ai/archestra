# Migration upgrades across release tracks

Drizzle runs migrations whose journal `when` is greater than the database's latest
recorded timestamp. It does not look for gaps by filename or SQL hash. A backport
can therefore make a later stable-to-beta upgrade silently skip beta migrations,
even when both journals are individually ordered.

## The prefix rule

Every deployed stable version must upgrade cleanly to the next stable patch, to
any later beta, and to the next stable line. The rule that guarantees this: a
stable branch's migration history must remain a timestamp-ordered prefix of
main's, matching migrations by SQL content so renamed backports count. Only
backport a migration when every earlier main migration is already present on
the stable branch. While the rule holds, an upgrade from any stable release
applies exactly the remaining suffix of main's history in canonical order, so
schema and data migrations converge with every other upgrade path.

A backport that skips earlier main migrations violates the rule, and the
cross-track check rejects it. Forward repairs exist to recover gaps that
already shipped, not to make such backports acceptable.

PR validation and release creation run `.github/scripts/check-migration-upgrades.py`.
The check compares stable release branches (`release/X.Y`) with main, and checks
upgrades within the target release line. SQL hashes recognize identical migrations
backported under different filenames. It rejects skipped migrations, absent source
SQL, and timestamp changes that would replay already-applied SQL.

## Released-tag upgrade replay

The static check proves journal compatibility; it cannot prove the SQL actually
converges. `backend/scripts/migration-tag-upgrades.test.mjs` replays the latest
release tag of every active stable branch with the real Drizzle migrator,
upgrades the resulting database to the worktree's history, and requires schema
convergence with a fresh install, no duplicate applied migrations, and survival
of pre-existing data. Tags are discovered per stable branch, so new stable lines
join the matrix automatically. Fetch `refs/tags/platform-v*` before running
locally; CI fetches them in the pull-request workflow.

Run from `platform/` after fetching the relevant refs:

```sh
python3 ../.github/scripts/check-migration-upgrades.py --base-branch main
python3 ../.github/scripts/check-migration-upgrades.py --source-ref platform-v1.3.56
pnpm --dir backend test:migration-upgrades
```

## Backporting a migration

Preserve the migration's SQL and timestamp, and confirm the prefix rule holds:
every earlier main migration must already be on the stable branch. The
cross-track check must pass before publishing the backport. Keep this guard in
the active stable branch's PR and release workflows too.

## Repairing an already-shipped gap

For an already-shipped gap, generate a new custom migration with a timestamp
newer than both tracks. Make the repair idempotent and preserve existing data.
Do not edit shipped migrations or rewind the database's migration ledger.

`upgrade-repairs.json` records explicit repair coverage. Each key is the new
repair's journal tag. Its value maps original migration tags to their SHA-256 SQL
hashes. The checker accepts coverage only if the original SQL matches and the
repair will run, or was already applied. This is reviewed coverage, not proof of
SQL equivalence: test the repair against missing, partially repaired, and healthy
schemas. Keep this file outside `meta/`, which Drizzle reserves for snapshots.

Use the real migrator in upgrade regression tests. The ordinary backend test
snapshot executes SQL files directly, so it cannot detect timestamp-based skips.
The static check does not prove SQL correctness, migration dependency order, or
lock safety; those still need database tests and migration review.
