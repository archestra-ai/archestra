---
name: archestra-dev-migrations
description: Use when changing Drizzle schemas, generating migrations, editing migration SQL, creating data-only migrations, diagnosing drizzle-kit check failures, or resolving migration/generated-client conflicts.
---

# Archestra Database Migrations

Use this skill for migration work.

Run commands from `platform/` unless specifically instructed otherwise.

## Merge/rebase conflicts

When git reports merge/rebase conflicts in Drizzle migration metadata or generated clients, follow `resolve-conflicts.md` instead of the normal migration flow.

That subpage overrides the default working directory rule and runs its procedure from the repo root where needed.

## Common commands

```bash
pnpm db:generate
pnpm exec drizzle-kit check
pnpm db:migrate
pnpm db:studio
```

Ask before applying migrations locally if the command will modify database state. Generating migrations and checking consistency are safe.

## Schema migrations

When creating migrations that include schema changes and data migration logic:

1. Update the Drizzle schema files with the schema changes.
2. Run `pnpm db:generate`.
3. Add the data migration SQL to the generated file.
4. Run `pnpm exec drizzle-kit check` to verify consistency.

Drizzle creates a migration with a generated name such as `0119_military_alice.sql`. Use that generated filename. Never create manually named migration files because Drizzle tracks migrations through `backend/src/database/migrations/meta/_journal.json`, which references generated file names.

## Data migration SQL

Data migration SQL can include statements such as `INSERT`, `UPDATE`, and other data-changing statements inside the generated migration file.

Keep schema DDL before data migration statements when the data migration references newly created tables or columns.

Always verify with `pnpm exec drizzle-kit check` after editing generated SQL.

## Custom data-only migrations

For pure data migrations with no schema changes, create an empty custom migration tracked by Drizzle:

```bash
pnpm --dir backend exec drizzle-kit generate --custom --name=<descriptive-name>
```

Then add the SQL to the generated file and run:

```bash
pnpm exec drizzle-kit check
```

## Database connection

PostgreSQL runs in Kubernetes when managed by Tilt.

```bash
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -U archestra -d archestra_dev
```

Useful read-only inspection commands inside `psql` include `\dt`, `\d table_name`, and `SELECT COUNT(*) FROM drizzle.__drizzle_migrations;`.
