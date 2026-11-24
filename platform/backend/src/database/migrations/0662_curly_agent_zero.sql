-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Intentional breaking change before auto routing's first stable release: the past-sessions backfill is removed, so its four tables, the trigger value it published plans under and the index that kept one past-sessions router per organization go. Plans published by a backfill are relabeled as settings fits before routing_plans_trigger_check is replaced; routing_plans holds a few rows per router, so re-validating it is brief. Queued backfill tasks are deleted because the task type no longer exists. The dropped tables are written only by the backfill and are dropped in foreign-key order, so nothing outside them goes with them. auto_routers.uses_past_sessions stays, unused. Older application pods read and write the dropped tables and enqueue the removed task type, so stop application processes for the upgrade.
UPDATE "routing_plans" SET "trigger" = 'settings' WHERE "trigger" = 'backfill';--> statement-breakpoint
ALTER TABLE "routing_plans" DROP CONSTRAINT "routing_plans_trigger_check";--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_trigger_check" CHECK ("routing_plans"."trigger" IN ('initial', 'nightly', 'settings', 'manual', 'scorer_change'));--> statement-breakpoint
DELETE FROM "tasks" WHERE "task_type" = 'auto_routing_backfill';--> statement-breakpoint
DROP INDEX "auto_routers_one_past_sessions_per_org_uidx";--> statement-breakpoint
DROP TABLE "routing_history_usage";--> statement-breakpoint
DROP TABLE "routing_history_scores";--> statement-breakpoint
DROP TABLE "routing_history_sessions";--> statement-breakpoint
DROP TABLE "routing_backfills";
