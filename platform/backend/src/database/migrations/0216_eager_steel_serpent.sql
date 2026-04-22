-- Additive columns on interactions: nullable, no backfill needed
ALTER TABLE "interactions" ADD COLUMN "billed_user_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "virtual_api_key_id" uuid;--> statement-breakpoint

-- limits.organization_id denormalizes the org scope onto the limit row so cleanup
-- becomes a single-table query and user-scoped limits disambiguate across orgs
-- (a better-auth user can belong to multiple organizations).
-- Add as NULLABLE first so existing rows can be backfilled before applying NOT NULL.
ALTER TABLE "limits" ADD COLUMN "organization_id" text;--> statement-breakpoint

-- Backfill: organization-scope limits use entity_id directly
UPDATE "limits" SET "organization_id" = "entity_id" WHERE "entity_type" = 'organization';--> statement-breakpoint

-- Backfill: team-scope limits resolve via the team row
UPDATE "limits" SET "organization_id" = "team"."organization_id"
FROM "team" WHERE "limits"."entity_type" = 'team' AND "team"."id" = "limits"."entity_id";--> statement-breakpoint

-- Backfill: agent-scope limits resolve via the agent row.
-- agents.id is uuid and limits.entity_id is text, so cast the uuid to text for comparison.
UPDATE "limits" SET "organization_id" = "agents"."organization_id"
FROM "agents" WHERE "limits"."entity_type" = 'agent' AND "agents"."id"::text = "limits"."entity_id";--> statement-breakpoint

-- Drop any limits whose entity reference could not be resolved (orphaned rows pointing
-- at deleted teams/agents or unknown entity types). Today limits.entity_id is polymorphic
-- text with no FK, so these orphans are invisible to enforcement anyway.
-- Log count before deletion so operators can audit what was dropped.
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM "limits" WHERE "organization_id" IS NULL;
  RAISE NOTICE '[migration 0213] Dropping % orphaned limits (unresolvable entity_id)', orphan_count;
END $$;--> statement-breakpoint

DELETE FROM "limits" WHERE "organization_id" IS NULL;--> statement-breakpoint

-- Now enforce NOT NULL; any remaining rows are guaranteed to have a value.
ALTER TABLE "limits" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "interactions" ADD CONSTRAINT "interactions_billed_user_id_user_id_fk" FOREIGN KEY ("billed_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limits" ADD CONSTRAINT "limits_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_billed_user_created_at_idx" ON "interactions" USING btree ("billed_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "interactions_virtual_api_key_id_idx" ON "interactions" USING btree ("virtual_api_key_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "limits_organization_id_idx" ON "limits" USING btree ("organization_id");
