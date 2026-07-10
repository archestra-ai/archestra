---
name: archestra-dev-interactions-migrations
description: Use BEFORE writing or running any Drizzle migration that touches the `interactions` table (or any other very large, write-hot table). The interactions table is the platform's biggest, append-heavy table — every LLM proxy call writes a row — so a careless migration can take a write-blocking lock and stall the proxy. Covers which operations are safe vs table-rewriting/lock-taking, the "never rebuild an index in a transactional migration" rule, and a read-only audit procedure against the GKE staging database to size the risk first.
---

# Migrations against the `interactions` table

The `interactions` table is special: it is the largest table in the platform and
is on the LLM proxy's hot write path — every proxied LLM call inserts a row. A
migration that takes a strong lock on it, even briefly, blocks those inserts, so
the proxy cannot record interactions until the migration finishes. On a large
table a "quick" `CREATE INDEX` can hold that lock for minutes.

Treat any schema change to `interactions` as production-risk work. The same rules
apply to any other very large, write-hot table.

## Safe vs risky operations

Safe (fast, metadata-only, no table rewrite in PostgreSQL 11+):

- `ADD COLUMN ... DEFAULT <constant> NOT NULL` — the default is stored as
  metadata; existing rows are not rewritten. This is instant regardless of table
  size. (The billing_mode column was added this way.)
- `ADD COLUMN` nullable, with no default.
- `DROP DEFAULT`, `SET DEFAULT <constant>`, renaming a column.

Risky (rewrites the whole table or takes a write-blocking lock — scales with
table size):

- `ADD COLUMN ... DEFAULT <volatile expr>` (e.g. `now()`, `gen_random_uuid()`) —
  rewrites every row.
- `ALTER COLUMN ... TYPE ...` — usually rewrites the table.
- `SET NOT NULL` on an existing column — full scan to validate.
- **`CREATE INDEX` / `DROP INDEX` (non-concurrent)** — this is the most common
  trap. A plain `CREATE INDEX` takes a `SHARE` lock that blocks writes for the
  entire build; adding a column to an existing covering index means a
  `DROP INDEX` + `CREATE INDEX` rebuild.

## The index rule

**Never add, drop, or rebuild an index on `interactions` inside a Drizzle
migration.** Drizzle runs each migration in a single transaction, and
`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` cannot run inside a
transaction — so the only thing a generated migration can emit is the blocking,
non-concurrent form.

Instead:

1. Keep the Drizzle schema's index definition matching what is actually deployed,
   so `pnpm db:generate` does not emit an index change. If you need a new index
   for a query, decide whether the query can tolerate a heap fetch instead — for
   an analytics query (not the hot path) it usually can.
2. If the index is genuinely needed, apply it out of band as an ops step with
   `CREATE INDEX CONCURRENTLY` (and `DROP INDEX CONCURRENTLY` for the old one)
   during a maintenance window, then update the schema to match. `CONCURRENTLY`
   builds without blocking writes, at the cost of a slower build and a second
   table scan.

The migration linter (`pnpm --dir backend check:migrations`) flags `DROP INDEX`
as an error and non-concurrent `CREATE INDEX` as a warning for exactly this
reason. If it fires on an `interactions` migration, stop and rework the change —
do not just add the `allow-breaking` marker.

## Audit the table on staging before you ship

Before merging a migration that touches `interactions`, size the real table on
the GKE staging database so you know the blast radius. This is **read-only** —
never run the migration DDL by hand against staging or production; migrations
deploy through the normal pipeline.

Access is via GCP/GKE IAM (managed separately from this repo), so the commands
below grant nothing on their own.

1. Switch kubectl to the GKE staging context:

   ```bash
   kubectl config get-contexts -o name | grep archestra-staging
   # e.g. gke_<project>_us-central1-a_archestra-staging
   kubectl config use-context <that-context>
   ```

2. Find the Postgres pod (namespace `archestra`, container `postgresql`):

   ```bash
   kubectl get pods -n archestra | grep postgresql   # archestra-platform-postgresql-0
   ```

3. Open a read-only psql session (use the app credentials already in the pod's
   environment; do not export secrets):

   ```bash
   kubectl exec -it -n archestra archestra-platform-postgresql-0 -c postgresql \
     -- bash -lc 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_USER"'
   ```

4. Run the audit queries (all read-only):

   ```sql
   -- PostgreSQL version. Metadata-only ADD COLUMN ... DEFAULT needs 11+.
   SELECT version();

   -- Fast row estimate. NEVER run count(*) on this table — it scans everything.
   SELECT reltuples::bigint AS est_rows, relpages
   FROM pg_class WHERE relname = 'interactions';

   -- Heap / TOAST / index sizes.
   SELECT pg_size_pretty(pg_total_relation_size('interactions')) AS total,
          pg_size_pretty(pg_relation_size('interactions'))       AS heap,
          pg_size_pretty(pg_indexes_size('interactions'))        AS indexes;

   -- Per-index size — a non-concurrent rebuild is at least this expensive.
   SELECT indexrelname,
          pg_size_pretty(pg_relation_size(indexrelid)) AS size
   FROM pg_stat_user_indexes
   WHERE relname = 'interactions'
   ORDER BY pg_relation_size(indexrelid) DESC;

   -- Long-running transactions. A CREATE INDEX waits behind these AND, once it
   -- starts, blocks writes until it finishes — so know what's open first.
   SELECT pid, now() - xact_start AS xact_age, state, left(query, 80) AS query
   FROM pg_stat_activity
   WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
   ORDER BY xact_start
   LIMIT 10;
   ```

5. Read the numbers:
   - Metadata-only changes (safe `ADD COLUMN`) are effectively instant no matter
     how big the table is — ship them normally.
   - A table rewrite or a non-concurrent index build scales with heap/index size.
     As a rough order of magnitude, an index build reads the whole table, sorts,
     and writes the index — expect it to be at least as slow as a full scan of
     the heap, and it holds the write lock the entire time. If that is more than
     a couple of seconds of estimated build time, do not do it in a transactional
     migration (see "The index rule").

When you switch away, restore your previous kubectl context
(`kubectl config use-context <previous>`).

## See also

- `archestra-dev-migrations` — the general migration flow (`pnpm db:generate`,
  `drizzle-kit check`, `check:migrations`, data migrations, conflict resolution).
