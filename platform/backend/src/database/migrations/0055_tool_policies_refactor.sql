-- Step 1: Create tool_policies table
CREATE TABLE "tool_policies" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "name" text NOT NULL UNIQUE,
    "tool_id" uuid NOT NULL REFERENCES "tools"("id") ON DELETE CASCADE,
    "allow_usage_when_untrusted_data_is_present" boolean DEFAULT false NOT NULL,
    "tool_result_treatment" text DEFAULT 'untrusted' NOT NULL,
    "response_modifier_template" text,
    "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE
);

-- Step 2: Create tool_policy_id column in agent_tools (nullable initially)
ALTER TABLE "agent_tools" ADD COLUMN "tool_policy_id" uuid REFERENCES "tool_policies"("id") ON DELETE SET NULL;

-- Step 3: Migrate data from agent_tools to tool_policies
-- For each unique combination of (tool_id, allow_usage_when_untrusted_data_is_present, tool_result_treatment, response_modifier_template),
-- create a tool_policy record with an auto-generated name
-- We need to get the organization_id from the agent's team relationship

WITH unique_policies AS (
    SELECT DISTINCT
        at.tool_id,
        at.allow_usage_when_untrusted_data_is_present,
        at.tool_result_treatment,
        at.response_modifier_template,
        t.organization_id
    FROM agent_tools at
    INNER JOIN agents a ON at.agent_id = a.id
    INNER JOIN agent_team agt ON a.id = agt.agent_id
    INNER JOIN team t ON agt.team_id = t.id
),
numbered_policies AS (
    SELECT
        tool_id,
        allow_usage_when_untrusted_data_is_present,
        tool_result_treatment,
        response_modifier_template,
        organization_id,
        ROW_NUMBER() OVER (PARTITION BY tool_id, organization_id ORDER BY tool_id) as policy_number
    FROM unique_policies
),
inserted_policies AS (
    INSERT INTO tool_policies (
        name,
        tool_id,
        allow_usage_when_untrusted_data_is_present,
        tool_result_treatment,
        response_modifier_template,
        organization_id
    )
    SELECT
        'Policy for ' || tools.name || ' - ' || np.policy_number,
        np.tool_id,
        np.allow_usage_when_untrusted_data_is_present,
        np.tool_result_treatment,
        np.response_modifier_template,
        np.organization_id
    FROM numbered_policies np
    INNER JOIN tools ON np.tool_id = tools.id
    RETURNING id, tool_id, allow_usage_when_untrusted_data_is_present, tool_result_treatment, response_modifier_template, organization_id
)
-- Step 4: Update agent_tools to reference the appropriate tool_policy_id
UPDATE agent_tools at
SET tool_policy_id = ip.id
FROM inserted_policies ip
INNER JOIN agents a ON at.agent_id = a.id
INNER JOIN agent_team agt ON a.id = agt.agent_id
INNER JOIN team t ON agt.team_id = t.id
WHERE at.tool_id = ip.tool_id
  AND at.allow_usage_when_untrusted_data_is_present = ip.allow_usage_when_untrusted_data_is_present
  AND at.tool_result_treatment = ip.tool_result_treatment
  AND COALESCE(at.response_modifier_template, '') = COALESCE(ip.response_modifier_template, '')
  AND t.organization_id = ip.organization_id;

-- Step 5: Drop the migrated columns from agent_tools
ALTER TABLE "agent_tools" DROP COLUMN "allow_usage_when_untrusted_data_is_present";
ALTER TABLE "agent_tools" DROP COLUMN "tool_result_treatment";
ALTER TABLE "agent_tools" DROP COLUMN "response_modifier_template";
