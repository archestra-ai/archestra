-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=routing_plans is unreleased and small (one row per fit); widening its status CHECK to add `rejected` in one step is safe.
ALTER TABLE "routing_plans" DROP CONSTRAINT "routing_plans_status_check";--> statement-breakpoint
ALTER TABLE "routing_plans" DROP CONSTRAINT "routing_plans_error_check";--> statement-breakpoint
UPDATE "routing_plans" SET "status" = 'rejected', "error" = substring("error" from length('Rejected at publication: ') + 1) WHERE "status" = 'failed' AND "error" LIKE 'Rejected at publication: %';--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_status_check" CHECK ("routing_plans"."status" IN ('active', 'superseded', 'failed', 'cold_start', 'rejected'));--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_error_check" CHECK ("routing_plans"."status" NOT IN ('failed', 'rejected') OR "routing_plans"."error" IS NOT NULL);