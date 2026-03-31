-- Rename JSONB key autoConfigureOnToolAssignment → autoConfigureOnToolDiscovery
-- in the built_in_agent_config column for Policy Configuration Subagent rows.
UPDATE "agents"
SET "built_in_agent_config" = jsonb_set(
  "built_in_agent_config" - 'autoConfigureOnToolAssignment',
  '{autoConfigureOnToolDiscovery}',
  COALESCE("built_in_agent_config" -> 'autoConfigureOnToolAssignment', 'false'::jsonb)
)
WHERE "built_in_agent_config" ->> 'name' = 'policy-configuration-subagent'
  AND "built_in_agent_config" ? 'autoConfigureOnToolAssignment';
