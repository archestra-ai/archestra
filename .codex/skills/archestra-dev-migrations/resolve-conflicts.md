# Resolving Drizzle migration merge conflicts

When main has landed migrations that collide with your branch's migration
number, drop YOUR generated migration artifacts and regenerate the migration
after taking main's migration metadata. Never edit main's migrations, and do
not hand-renumber a migration unless regeneration is impossible.

`pnpm db:generate` emits ONLY schema DDL diffed against the latest snapshot.
Data changes (including DELETE) and custom DDL not represented in the Drizzle
schema are NOT regenerated. Back up the original SQL and preserve those
operations when regenerating against main's snapshot.

All paths below are relative to the **repo root**, not `platform/`. Run the
shell commands from the repo root unless a step explicitly `cd`s elsewhere
(this skill overrides the platform-CLAUDE-default of running from
`platform/`).

## Variables

- `<COLLIDING>` — the 4-digit number both branches claimed (e.g. `0220`).
- `<your_name>` — your migration's descriptive slug (e.g. for
  `0220_luxuriant_silver_sable.sql`, it is `luxuriant_silver_sable`).
- `<NEW>` — the next free 4-digit number Drizzle picks in step 4 (e.g. `0221`).

## Procedure

### 1. Preserve your manually authored SQL

Read `platform/backend/src/database/migrations/<COLLIDING>_<your_name>.sql`.
Copy the whole file to `/tmp/<COLLIDING>_<your_name>.original.sql` as a
backup. Save operations that schema generation cannot reproduce to
`/tmp/<your_name>.custom.sql`, separated by `--> statement-breakpoint`.

These include UPDATE, INSERT, standalone DELETE, DO blocks, mutating CTEs,
and custom DDL such as extension creation. Do not discard an operation just
because it starts with ALTER or CREATE: verify that the Drizzle schema and
regenerated SQL preserve its meaning, including renames. Note ordering
requirements, such as a backfill before a constraint or a cleanup before a drop.

If no custom operations remain, the saved file is empty.

### 2. Take main's side for the conflicted journal + snapshot

The flag depends on the git operation in progress — `git rebase` and `git
merge` invert "ours" vs. "theirs". Run `git status` to check which is
running:

- `git rebase upstream` → main is **`--ours`** (rebase checks out
  upstream's tip before replaying your commits, so `HEAD = main`):
  ```
  git checkout --ours -- \
    platform/backend/src/database/migrations/meta/_journal.json \
    platform/backend/src/database/migrations/meta/<COLLIDING>_snapshot.json
  ```
- `git merge upstream` → main is **`--theirs`** (HEAD stays on your
  branch; upstream is the incoming side):
  ```
  git checkout --theirs -- \
    platform/backend/src/database/migrations/meta/_journal.json \
    platform/backend/src/database/migrations/meta/<COLLIDING>_snapshot.json
  ```

Then stage:

```
git add \
  platform/backend/src/database/migrations/meta/_journal.json \
  platform/backend/src/database/migrations/meta/<COLLIDING>_snapshot.json
```

**Verify you took the right side**: the last `tag` in `_journal.json`
should be **main's** latest tag, NOT `<COLLIDING>_<your_name>`. If you see
your own tag, you took the wrong side — re-run step 2 with the opposite
flag.

**Before step 4**, resolve ALL TypeScript files that still have conflict
markers (`<<<<<<<`, `=======`, `>>>>>>>`) — not just hey-api files. Step 4
runs `drizzle-kit generate`, which uses esbuild to walk every file reachable
from your schemas (shared utilities, generated SDK, anything imported
transitively). One unresolved `<<<<<<<` anywhere along that import graph
makes `drizzle-kit generate` exit with `ERROR: Unexpected "<<"`. For files
that will be regenerated in step 8 (e.g. `platform/shared/hey-api/**`),
resolving with `git checkout --ours` or `--theirs` just-enough-to-parse is
fine; for hand-written code, resolve properly. Run `git status` and check
for any `UU` entries; resolve each before continuing.

### 3. Delete only your obsolete migration SQL

```
git rm -f \
  platform/backend/src/database/migrations/<COLLIDING>_<your_name>.sql
```

The SQL file may already be staged, so `-f` is needed. **Keep the colliding
snapshot restored from main in step 2.** Verify main's latest snapshot still
exists before generation; deleting it loses the schema baseline. If your branch's
journal entry still exists in `_journal.json`, remove that entry before
regenerating. The journal should end at main's latest migration at this point.

### 4. Regenerate the migration with your descriptive name

```
pnpm --dir platform/backend exec drizzle-kit generate --name=<your_name>
```

Drizzle picks the next free `<NEW>`, emits `<NEW>_<your_name>.sql` with
schema-only DDL diffed against main's snapshot, writes
`meta/<NEW>_snapshot.json`, and appends a journal entry tagged
`<NEW>_<your_name>`. The `--name=` flag means the filename and tag are
right the first time — no journal-tag rename needed. Let Drizzle create the
journal timestamp; do not copy the old timestamp from your collided migration.

If Drizzle reports "No schema changes, nothing to migrate" but saved custom
operations still need to run, generate a custom empty migration instead:

```
pnpm --dir platform/backend exec drizzle-kit generate --custom --name=<your_name>
```

### 5. Restore custom operations in dependency order

Compare the backed-up original SQL with the regenerated migration. Restore each
operation from `/tmp/<your_name>.custom.sql` that is not already represented,
with `--> statement-breakpoint` separators. Put operations that reference new
columns after their creation, backfills before constraints that depend on them,
and cleanup before dropping the objects it reads. Append only when all saved
operations genuinely belong after the generated DDL.

Account for every operation in the original SQL, even when the generated
migration passes validation; schema checks cannot detect a missing data cleanup.

### 6. Verify journal/snapshot/SQL consistency

```
pnpm --dir platform/backend exec drizzle-kit check
```

Must print **"Everything's fine"**. Then run the same checks CI runs — journal
ordering plus the Drizzle migration linter over migrations changed relative to
`origin/main`:

```
pnpm --dir platform/backend check:migrations
```

The journal check must print **"Drizzle migration journal ordering is valid."**
If it fails, your regenerated migration was not appended after main's latest
migration, or its journal timestamp was copied/edited incorrectly. The linter
fails separately, with `ERROR <code>` lines pointing at the migration file —
that is a lint problem in the regenerated/edited SQL (often the restored
custom SQL), not a journal problem.

If `drizzle-kit check` reports drift, compare
`/tmp/<COLLIDING>_<your_name>.original.sql` against the regenerated SQL and
either (a) restore a missed custom operation in dependency order, or
(b) update your schema files so the regenerated DDL matches what your
original SQL did.

### 7. (Optional) Apply locally to confirm it runs

```
pnpm --dir platform/backend db:migrate
```

### 8. Regenerate conflicted generated clients (only if hey-api files conflicted)

Skip this step unless step 2 surfaced conflicts under `platform/shared/hey-api/`
(check `git status` from step 2 — if no hey-api paths were unmerged, jump to
step 9).

```
CODEGEN=true pnpm --dir platform/shared codegen:api-client
```

### 9. Stage and continue

```
git add \
  platform/backend/src/database/migrations/<NEW>_<your_name>.sql \
  platform/backend/src/database/migrations/meta/<NEW>_snapshot.json \
  platform/backend/src/database/migrations/meta/_journal.json
```

Also stage `platform/shared/hey-api` if step 8 ran.

Then continue the rebase/merge.
