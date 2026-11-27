-- Every auto router may learn from the organization's scored past sessions,
-- at a volume scaled by its expected traffic factor. Scoring runs record the
-- key that pays for them and the generation they asked each router's fit
-- for, and fits record the past-sessions frame and the
-- factor they planned for. Stop application processes for the upgrade.
ALTER TABLE "auto_routers" ADD COLUMN "learn_from_past_sessions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_routers" ADD COLUMN "expected_traffic_factor" numeric DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_backfills" ADD COLUMN "scorer_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "routing_backfills" ADD COLUMN "fit_generations" jsonb;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD COLUMN "history_frame_id" uuid;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD COLUMN "volume_factor" numeric;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD COLUMN "volume_source" text;--> statement-breakpoint
ALTER TABLE "auto_routers" ADD CONSTRAINT "auto_routers_expected_traffic_factor_check" CHECK ("auto_routers"."expected_traffic_factor" > 0 AND "auto_routers"."expected_traffic_factor" <= 100) NOT VALID;--> statement-breakpoint
ALTER TABLE "auto_routers" VALIDATE CONSTRAINT "auto_routers_expected_traffic_factor_check";--> statement-breakpoint
-- The router an organization had before it could have several keeps learning
-- from past sessions; routers created since started cold and stay so until an
-- admin turns learning on. auto_routers holds a few rows per organization.
UPDATE "auto_routers"
SET "learn_from_past_sessions" = "uses_past_sessions"
WHERE "learn_from_past_sessions" IS DISTINCT FROM "uses_past_sessions";--> statement-breakpoint
-- A scoring run started before runs recorded their payer pinned none, so it
-- ends here and keeps what it scored; every later paid call is admitted with
-- an organization-wide key. routing_backfills holds a row per job.
UPDATE "routing_backfills"
SET "status" = 'failed',
  "error" = 'Stopped by the upgrade. Start scoring again to finish.',
  "completed_at" = now(),
  "lease_owner" = NULL,
  "lease_expires_at" = NULL
WHERE "phase" = 'score' AND "status" = 'running' AND "scorer_api_key_id" IS NULL;--> statement-breakpoint
-- The fit a finished scoring run asked of the router that read past sessions
-- then, by router as runs record it now.
UPDATE "routing_backfills" AS b
SET "fit_generations" = jsonb_build_object(r."id"::text, b."fit_generation")
FROM "auto_routers" AS r
WHERE b."fit_generation" IS NOT NULL
  AND b."fit_generations" IS NULL
  AND r."organization_id" = b."organization_id"
  AND r."uses_past_sessions";
