# Migration upgrades across release tracks

Drizzle runs migrations whose journal `when` is greater than the database's latest
recorded timestamp. It does not look for gaps by filename or SQL hash. A backport
can therefore make a later stable-to-beta upgrade silently skip beta migrations,
even when both journals are individually ordered.

PR validation and release creation run `.github/scripts/check-migration-upgrades.py`.
The check compares stable release branches (`release/X.Y`) with main, and checks
upgrades within the target release line. SQL hashes recognize identical migrations
backported under different filenames. It rejects skipped migrations, absent source
SQL, and timestamp changes that would replay already-applied SQL.

Run from `platform/` after fetching the relevant refs:

```sh
python3 ../.github/scripts/check-migration-upgrades.py --base-branch main
python3 ../.github/scripts/check-migration-upgrades.py --source-ref platform-v1.3.56
pnpm --dir backend test:migration-upgrades
```

When backporting a migration, preserve its SQL and timestamp. Preserving the
timestamp alone is not sufficient: earlier beta-only migrations may still be
skipped. The cross-track check must pass before publishing the backport. Land any
required forward repair on main first. Keep this guard in the active stable
branch's PR and release workflows too.

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
