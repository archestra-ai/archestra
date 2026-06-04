# Drizzle Migration Linter

`@archestra/drizzle-migration-linter` checks Drizzle-generated PostgreSQL
migration SQL for changes that are unsafe during rolling deploys.

The goal is the same deployment discipline as tools like
[`django-migration-linter`](https://github.com/3YOURMIND/django-migration-linter):
catch schema changes that can break an older app version while new pods are
rolling out, and require an explicit review marker for rare contract
migrations.

This package is local to the Archestra workspace. It is structured as a normal
pnpm workspace package so it can be tested and evolved independently.

## Usage

Lint every migration in a directory:

```bash
pnpm --filter @archestra/drizzle-migration-linter lint -- \
  --migrations-dir backend/src/database/migrations \
  --all
```

Lint only migration files changed relative to a git ref:

```bash
pnpm --filter @archestra/drizzle-migration-linter lint -- \
  --migrations-dir backend/src/database/migrations \
  --changed-base origin/main
```

Lint specific files:

```bash
pnpm --filter @archestra/drizzle-migration-linter lint -- \
  backend/src/database/migrations/0275_example.sql
```

JSON output is available for CI annotations or future automation:

```bash
pnpm --filter @archestra/drizzle-migration-linter lint -- \
  --migrations-dir backend/src/database/migrations \
  --changed-base origin/main \
  --format json
```

## Rules

The linter reports errors for operations that are not compatible with a mixed
old-code/new-code rollout:

- `DROP TABLE`
- `DROP COLUMN`
- table or column rename
- `ALTER COLUMN ... SET NOT NULL`
- `ALTER COLUMN ... TYPE`
- adding a `NOT NULL` column without a `DEFAULT`
- dropping constraints or indexes
- adding uniqueness
- adding validating constraints without `NOT VALID`
- dropping or renaming types

It reports warnings for operations that may be valid but deserve review:

- `CASCADE`
- `CREATE INDEX` without `CONCURRENTLY`
- unbounded `UPDATE`
- unbounded `DELETE`

## Overrides

Use an override only for reviewed contract migrations that are intentionally not
rollout-safe, usually after a prior expand release has already removed runtime
usage of the old schema.

```sql
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=old column unused since platform-v1.2.60
ALTER TABLE "agents" DROP COLUMN "legacy_name";
```

The override suppresses error-level contract rules. Warnings still appear.

## Expand/Contract Pattern

For a column rename, do not ship `RENAME COLUMN` in the same release as app code
that depends on the new name.

Use multiple releases:

1. Add the new nullable column.
2. Deploy app code that writes both columns and reads `new_column ?? old_column`.
3. Backfill existing rows.
4. Deploy app code that reads the new column.
5. Drop the old column in a later contract migration with an explicit override.

## Interface With Drizzle

The interface is intentionally simple: Drizzle writes `.sql` files, and this
package lints those files.

Drizzle Kit does not provide a stable migration-lint hook/plugin surface that
fits this use case. Running a standalone CLI in CI keeps the integration
portable and easy to reason about.

## Development

Run tests:

```bash
pnpm --filter @archestra/drizzle-migration-linter test
```

Run type-checking:

```bash
pnpm --filter @archestra/drizzle-migration-linter type-check
```

Run the linter against the current package fixtures or repo migrations:

```bash
pnpm --filter @archestra/drizzle-migration-linter lint -- --all
```
