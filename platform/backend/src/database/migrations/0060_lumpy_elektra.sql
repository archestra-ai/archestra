ALTER TABLE "optimization_rules" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD COLUMN "organization_id" text;--> statement-breakpoint
-- Infer organization id from agent id
UPDATE "optimization_rules" SET "organization_id" = (
  SELECT COALESCE(
    (SELECT t.organization_id
     FROM agent_team at
     JOIN team t ON t.id = at.team_id
     WHERE at.agent_id = optimization_rules.agent_id
     LIMIT 1),
    (SELECT id FROM organization LIMIT 1)
  )
) WHERE "organization_id" IS NULL;--> statement-breakpoint
-- Clear agent_id to make all rules organization-wide
UPDATE "optimization_rules" SET "agent_id" = NULL;--> statement-breakpoint
ALTER TABLE "optimization_rules" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD CONSTRAINT "optimization_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
