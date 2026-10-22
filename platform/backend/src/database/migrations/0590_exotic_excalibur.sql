-- Bound acquisition of metadata-only column locks on write-hot tables.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "interaction_billing" ADD COLUMN "attribution_labels" jsonb;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "attribution_labels" jsonb;
