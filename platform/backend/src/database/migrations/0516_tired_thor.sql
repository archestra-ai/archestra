ALTER TABLE "openappa_battery_installs" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "openappa_battery_installs" ADD COLUMN "detected_id" text;--> statement-breakpoint
-- Rows written before the kind existed: a catalog row governs its catalog, the rest the organization.
UPDATE "openappa_battery_installs" SET "kind" = CASE WHEN "catalog_id" IS NULL THEN 'organization' ELSE 'catalog' END WHERE "kind" IS NULL;
