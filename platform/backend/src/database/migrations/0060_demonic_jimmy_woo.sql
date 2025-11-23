ALTER TABLE "optimization_rules" DROP CONSTRAINT "optimization_rules_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD COLUMN "entity_type" varchar;--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD COLUMN "entity_id" text;--> statement-breakpoint

-- Migrate existing data:
-- Set entity_type to 'organization' and infer organization_id from agent_id via team membership
UPDATE "optimization_rules" SET
  "entity_type" = 'organization',
  "entity_id" = (
    SELECT COALESCE(
      (SELECT t.organization_id
       FROM agent_team at
       JOIN team t ON t.id = at.team_id
       WHERE at.agent_id = optimization_rules.agent_id
       LIMIT 1),
      (SELECT id FROM organization LIMIT 1)
    )
  );--> statement-breakpoint

-- Make columns NOT NULL after populating them
ALTER TABLE "optimization_rules" ALTER COLUMN "entity_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "optimization_rules" ALTER COLUMN "entity_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "optimization_rules_entity_idx" ON "optimization_rules" USING btree ("entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "optimization_rules" DROP COLUMN "agent_id";
