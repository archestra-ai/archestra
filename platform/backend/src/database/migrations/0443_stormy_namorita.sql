-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=agent_runs, agent_execution_inputs, and the ChatOps completion columns were introduced by the immediately preceding unreleased, separately feature-flagged Background execution migration. This migration generalizes their actor and completion ownership before general availability, backfills every existing staging row, and removes the superseded shape in the same release. These tables hold only short-lived execution data, so the bounded operational risk of the non-concurrent actor index and full-table backfill is accepted.
ALTER TABLE "agent_runs" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_execution_inputs" ALTER COLUMN "uploaded_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "actor_kind" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "completion_target" jsonb;--> statement-breakpoint
UPDATE "agent_runs"
SET
  "actor_kind" = 'user',
  "actor_id" = "actor_user_id",
  "completion_target" = CASE
    WHEN "chatops_binding_id" IS NOT NULL AND "chatops_thread_id" IS NOT NULL
      THEN jsonb_build_object(
        'type', 'chatops',
        'bindingId', "chatops_binding_id",
        'threadId', "chatops_thread_id"
      )
    ELSE NULL
  END;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "actor_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "actor_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_actor_idx" ON "agent_runs" USING btree ("actor_kind","actor_id");--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "chatops_binding_id";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "chatops_thread_id";
