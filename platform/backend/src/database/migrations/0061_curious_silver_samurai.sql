CREATE TABLE "tool_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"tool_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"allow_usage_when_untrusted_data_is_present" boolean DEFAULT false NOT NULL,
	"tool_result_treatment" varchar(50) DEFAULT 'untrusted' NOT NULL,
	"response_modifier_template" text,
	CONSTRAINT "tool_policies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "tool_policy_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tool_policies" ADD CONSTRAINT "tool_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_policy_id_tool_policies_id_fk" FOREIGN KEY ("tool_policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

DO $$
DECLARE
  fallback_org_id text;
BEGIN
  SELECT id INTO fallback_org_id FROM "organization" LIMIT 1;

  IF fallback_org_id IS NULL THEN
    INSERT INTO "organization" (id, name, slug, created_at)
    VALUES ('default-org', 'Default Organization', 'default', now())
    ON CONFLICT (id) DO NOTHING;

    SELECT id INTO fallback_org_id FROM "organization" LIMIT 1;
  END IF;

  WITH agent_orgs AS (
    SELECT
      ag.id AS agent_id,
      COALESCE(
        (
          SELECT tm.organization_id
          FROM "agent_team" agt
          JOIN "team" tm ON tm.id = agt.team_id
          WHERE agt.agent_id = ag.id
          LIMIT 1
        ),
        fallback_org_id
      ) AS organization_id
    FROM "agents" ag
  ),
  unique_configs AS (
    SELECT DISTINCT
      at.tool_id,
      ao.organization_id,
      at.allow_usage_when_untrusted_data_is_present,
      at.tool_result_treatment,
      at.response_modifier_template
    FROM "agent_tools" at
    JOIN agent_orgs ao ON ao.agent_id = at.agent_id
  ),
  numbered_policies AS (
    SELECT
      tool_id,
      organization_id,
      allow_usage_when_untrusted_data_is_present,
      tool_result_treatment,
      response_modifier_template,
      ROW_NUMBER() OVER (
        PARTITION BY tool_id, organization_id
        ORDER BY
          allow_usage_when_untrusted_data_is_present DESC,
          tool_result_treatment,
          COALESCE(response_modifier_template, '')
      ) AS policy_index
    FROM unique_configs
  ),
  inserted AS (
    INSERT INTO "tool_policies" (
      name,
      tool_id,
      organization_id,
      allow_usage_when_untrusted_data_is_present,
      tool_result_treatment,
      response_modifier_template
    )
    SELECT
      'Policy for ' || COALESCE(t.name, 'Tool') || ' - ' || policy_index || ' (' || LEFT(organization_id, 8) || ')',
      np.tool_id,
      np.organization_id,
      np.allow_usage_when_untrusted_data_is_present,
      np.tool_result_treatment,
      np.response_modifier_template
    FROM numbered_policies np
    LEFT JOIN "tools" t ON t.id = np.tool_id
    WHERE t.name NOT LIKE 'archestra__%'
    RETURNING id,
      tool_id,
      organization_id,
      allow_usage_when_untrusted_data_is_present,
      tool_result_treatment,
      response_modifier_template
  ),
  assignments AS (
    SELECT
      at.id AS agent_tool_id,
      inserted.id AS policy_id
    FROM agent_tools at
    JOIN agent_orgs ao ON ao.agent_id = at.agent_id
    JOIN inserted ON
      inserted.tool_id = at.tool_id
      AND inserted.organization_id = ao.organization_id
      AND inserted.allow_usage_when_untrusted_data_is_present =
        at.allow_usage_when_untrusted_data_is_present
      AND inserted.tool_result_treatment = at.tool_result_treatment
      AND COALESCE(inserted.response_modifier_template, '') =
        COALESCE(at.response_modifier_template, '')
  )
  UPDATE agent_tools
  SET tool_policy_id = assignments.policy_id
  FROM assignments
  WHERE assignments.agent_tool_id = agent_tools.id;
END $$;

ALTER TABLE "agent_tools" DROP COLUMN "allow_usage_when_untrusted_data_is_present";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "tool_result_treatment";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "response_modifier_template";

ALTER TABLE "tool_invocation_policies" DROP CONSTRAINT "tool_invocation_policies_agent_tool_id_agent_tools_id_fk";
--> statement-breakpoint
ALTER TABLE "trusted_data_policies" DROP CONSTRAINT "trusted_data_policies_agent_tool_id_agent_tools_id_fk";
--> statement-breakpoint

-- Add tool_policy_id to tool_invocation_policies and trusted_data_policies
ALTER TABLE "tool_invocation_policies" ADD COLUMN "tool_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "trusted_data_policies" ADD COLUMN "tool_policy_id" uuid;--> statement-breakpoint


ALTER TABLE "tool_invocation_policies" ADD CONSTRAINT "tool_invocation_policies_tool_policy_id_tool_policies_id_fk" FOREIGN KEY ("tool_policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "trusted_data_policies" ADD CONSTRAINT "trusted_data_policies_tool_policy_id_tool_policies_id_fk" FOREIGN KEY ("tool_policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Backfill tool_policy_id from agent_tools.tool_policy_id using existing agent_tool_id links
UPDATE "tool_invocation_policies" tip
SET tool_policy_id = at.tool_policy_id
FROM "agent_tools" at
WHERE tip.agent_tool_id = at.id
  AND at.tool_policy_id IS NOT NULL;

UPDATE "trusted_data_policies" tdp
SET tool_policy_id = at.tool_policy_id
FROM "agent_tools" at
WHERE tdp.agent_tool_id = at.id
  AND at.tool_policy_id IS NOT NULL;

-- Enforce NOT NULL on tool_policy_id now that backfill is done
ALTER TABLE "tool_invocation_policies" ALTER COLUMN "tool_policy_id" SET NOT NULL;
ALTER TABLE "trusted_data_policies" ALTER COLUMN "tool_policy_id" SET NOT NULL;

-- Drop old agent_tool_id columns
ALTER TABLE "tool_invocation_policies" DROP COLUMN "agent_tool_id";--> statement-breakpoint
ALTER TABLE "trusted_data_policies" DROP COLUMN "agent_tool_id";
