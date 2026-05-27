---
name: resolve-conflicts
description: Resolve merge/rebase conflicts in this repo — Drizzle migration number collisions (platform/backend/src/database/migrations/meta/_journal.json, meta/<NNNN>_snapshot.json), preserving any hand-written data-migration tail (UPDATE/INSERT/DO $$). Use when git reports a conflict in those files, when `drizzle-kit check` fails after a merge, or when conflicted generated clients under platform/shared/hey-api/** need to be reconciled.
---

# Resolving Drizzle migration merge conflicts

When main has landed migrations that collide with your branch's migration
number, you must renumber YOUR migration to come AFTER main's. Never edit
main's migrations.

`pnpm db:generate` emits ONLY schema DDL diffed against the latest snapshot.
Any data-migration tail (UPDATE, INSERT, DO $$ blocks, mutating CTEs) is NOT
regenerated. The procedure below regenerates fresh DDL against main's
snapshot, then re-appends your saved data-migration tail.

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

### 1. Extract your data-migration tail

Read `platform/backend/src/database/migrations/<COLLIDING>_<your_name>.sql`.
Copy the whole file to `/tmp/<COLLIDING>_<your_name>.original.sql` as a
backup. Then save just the data-migration statements to
`/tmp/<your_name>.data.sql`, each separated by `--> statement-breakpoint`.

Statements to save (Drizzle does NOT regenerate these):
- `UPDATE …`
- `INSERT INTO …` (when used for data, not as part of `CREATE TABLE`)
- `DO $$ … END $$;` blocks
- `WITH … (INSERT|UPDATE|DELETE) …` CTEs

Statements to DISCARD (Drizzle WILL regenerate these):
- `ALTER TABLE …`, `ALTER COLUMN …`
- `CREATE TABLE/INDEX/TYPE/EXTENSION …`
- `DROP TABLE/COLUMN/INDEX …`

If the file has no data-migration tail, `/tmp/<your_name>.data.sql` is empty
and step 5 is a no-op.

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

### 3. Delete your old SQL file

```
git rm -f platform/backend/src/database/migrations/<COLLIDING>_<your_name>.sql
```

(The file is staged from the in-progress rebase/merge; plain `git rm`
refuses to remove staged files, so `-f` is needed.)

### 4. Regenerate the migration with your descriptive name

```
cd platform/backend && pnpm exec drizzle-kit generate --name=<your_name>
```

Drizzle picks the next free `<NEW>`, emits `<NEW>_<your_name>.sql` with
schema-only DDL diffed against main's snapshot, writes
`meta/<NEW>_snapshot.json`, and appends a journal entry tagged
`<NEW>_<your_name>`. The `--name=` flag means the filename and tag are
right the first time — no journal-tag rename needed.

If Drizzle reports "No schema changes, nothing to migrate", your branch was
pure-data; generate a custom empty migration instead:

```
cd platform/backend && pnpm exec drizzle-kit generate --custom --name=<your_name>
```

### 5. Append the saved data-migration tail

Skip this step if `/tmp/<your_name>.data.sql` is empty.

```
printf '\n--> statement-breakpoint\n' \
  >> platform/backend/src/database/migrations/<NEW>_<your_name>.sql
cat /tmp/<your_name>.data.sql \
  >> platform/backend/src/database/migrations/<NEW>_<your_name>.sql
```

Schema DDL must run before the data migration so column references resolve.

### 6. Verify journal/snapshot/SQL consistency

```
cd platform/backend && pnpm exec drizzle-kit check
```

Must print **"Everything's fine"**. If it reports drift, compare
`/tmp/<COLLIDING>_<your_name>.original.sql` against the regenerated SQL and
either (a) restore a missed data-migration statement to the tail, or
(b) update your schema files so the regenerated DDL matches what your
original SQL did.

### 7. (Optional) Apply locally to confirm it runs

```
cd platform/backend && pnpm db:migrate
```

### 8. Regenerate conflicted generated clients (only if hey-api files conflicted)

Skip this step unless step 2 surfaced conflicts under `platform/shared/hey-api/`
(check `git status` from step 2 — if no hey-api paths were unmerged, jump to
step 9).

```
cd platform/shared && CODEGEN=true pnpm codegen:api-client
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
