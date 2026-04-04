ALTER TABLE "agents" ADD COLUMN "built_in_agent_config" jsonb;--> statement-breakpoint

-- Insert Policy Configuration Subagent as built-in agent for each organization
-- Copies the org's auto_configure_new_tools value before it's dropped
INSERT INTO agents (
  id, organization_id, scope, name, is_demo, is_default,
  consider_context_untrusted, agent_type, description,
  system_prompt, built_in_agent_config, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  o.id,
  'org',
  'Policy Configuration Subagent',
  false, false, false, 'agent',
  'Analyzes tool metadata with AI to generate deterministic security policies for handling untrusted data',
  E'Analyze this MCP tool and determine security policies:\n\nTool: {tool.name}\nDescription: {tool.description}\nMCP Server: {mcpServerName}\nParameters: {tool.parameters}\n\nDetermine:\n\n1. toolInvocationAction (enum) - When should this tool be allowed?\n   - "allow_when_context_is_untrusted": Safe to invoke even with untrusted data (read-only, doesn''t leak sensitive data)\n   - "block_when_context_is_untrusted": Only invoke when context is trusted (could leak data if untrusted input is present)\n   - "block_always": Never invoke automatically (writes data, executes code, sends data externally)\n\n2. trustedDataAction (enum) - How should the tool''s results be treated?\n   - "mark_as_trusted": Internal systems (databases, APIs, dev tools like list-endpoints/get-config)\n   - "mark_as_untrusted": External/filesystem data where exact values are safe to use directly\n   - "sanitize_with_dual_llm": Untrusted data that needs summarization without exposing exact values\n   - "block_always": Highly sensitive or dangerous output that should be blocked entirely\n\nExamples:\n- Internal dev tools: invocation="allow_when_context_is_untrusted", result="mark_as_trusted"\n- Database queries: invocation="allow_when_context_is_untrusted", result="mark_as_trusted"\n- File reads (code/config): invocation="allow_when_context_is_untrusted", result="mark_as_untrusted"\n- Web search/scraping: invocation="allow_when_context_is_untrusted", result="sanitize_with_dual_llm"\n- File writes: invocation="block_always", result="mark_as_trusted"\n- External APIs (raw data): invocation="block_when_context_is_untrusted", result="mark_as_untrusted"\n- Code execution: invocation="block_always", result="mark_as_untrusted"',
  jsonb_build_object(
    'name', 'policy-configuration-subagent',
    'autoConfigureOnToolAssignment', COALESCE(o.auto_configure_new_tools, false)
  ),
  now(), now()
FROM organization o;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "auto_configure_new_tools";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "built_in" boolean GENERATED ALWAYS AS ("agents"."built_in_agent_config" IS NOT NULL) STORED;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "policies_auto_configured_model" text;