-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Enforces the new single-flight invariant (at most one "running" connector_run per connector). Pre-existing duplicate "running" rows from the old supersede-on-start path are deduped in the UPDATE immediately above the CREATE UNIQUE INDEX, and no code path depends on multiple concurrent running runs (that concurrency was the bug being fixed here).
ALTER TABLE "connector_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "lease_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
-- Reconcile any pre-existing duplicate "running" runs (left by the old
-- supersede-on-start path before single-flight was enforced): keep the most
-- recently started run per connector and mark the rest superseded, so the
-- unique partial index below can be created.
UPDATE "connector_runs" SET "status" = 'superseded', "completed_at" = now()
WHERE "status" = 'running'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("connector_id") "id"
    FROM "connector_runs"
    WHERE "status" = 'running'
    ORDER BY "connector_id", "started_at" DESC
  );--> statement-breakpoint
-- Give surviving running runs a lease deadline so the reaper does not treat
-- them as orphaned the instant this migration lands.
UPDATE "connector_runs" SET "lease_expires_at" = now() + interval '5 minutes'
WHERE "status" = 'running' AND "lease_expires_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_runs_one_running_per_connector_idx" ON "connector_runs" USING btree ("connector_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "connector_runs_lease_expires_at_idx" ON "connector_runs" USING btree ("lease_expires_at") WHERE status = 'running';--> statement-breakpoint
-- Index the reaper's drain-liveness probe: does an expired-lease run still have a
-- live (pending/processing) batch_embedding task? Partial + expression, so only
-- in-flight embedding tasks are indexed, keyed by their payload's connectorRunId.
CREATE INDEX "tasks_batch_embedding_connector_run_idx" ON "tasks" USING btree (("payload" ->> 'connectorRunId')) WHERE "tasks"."task_type" = 'batch_embedding' AND "tasks"."status" IN ('pending', 'processing');
