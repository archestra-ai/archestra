-- Migrate proxy-sniffed tools from per-agent (agent_id set) to shared (agent_id=NULL).
-- Proxy tools: agent_id IS NOT NULL AND catalog_id IS NULL AND delegate_to_agent_id IS NULL.
-- After migration, proxy tools become shared like MCP tools: agent_id=NULL, no agent_tools links.

-- Step 1: Delete proxy tools discovered by non-profile/non-llm_proxy agents.
-- These are stale duplicates from internal agents that should not be shared.
DELETE FROM agent_tools
WHERE tool_id IN (
  SELECT t.id FROM tools t
  JOIN agents a ON a.id = t.agent_id
  WHERE t.agent_id IS NOT NULL
    AND t.catalog_id IS NULL
    AND t.delegate_to_agent_id IS NULL
    AND a.agent_type NOT IN ('profile', 'llm_proxy')
);
--> statement-breakpoint

DELETE FROM tools
WHERE id IN (
  SELECT t.id FROM tools t
  JOIN agents a ON a.id = t.agent_id
  WHERE t.agent_id IS NOT NULL
    AND t.catalog_id IS NULL
    AND t.delegate_to_agent_id IS NULL
    AND a.agent_type NOT IN ('profile', 'llm_proxy')
);
--> statement-breakpoint

-- Step 2: Delete all agent_tools entries for proxy tools.
-- Going forward, proxy tools are not linked to agents via agent_tools.
DELETE FROM agent_tools
WHERE tool_id IN (
  SELECT id FROM tools
  WHERE catalog_id IS NULL
    AND delegate_to_agent_id IS NULL
);
--> statement-breakpoint

-- Step 3: Deduplicate proxy tools (keep newest per name) and remove those with catalog equivalents.
DELETE FROM tools
WHERE agent_id IS NOT NULL
  AND catalog_id IS NULL
  AND delegate_to_agent_id IS NULL
  AND (
    -- Not the newest tool for this name (duplicate)
    id NOT IN (
      SELECT DISTINCT ON (name) id FROM tools
      WHERE agent_id IS NOT NULL AND catalog_id IS NULL AND delegate_to_agent_id IS NULL
      ORDER BY name, created_at DESC
    )
    -- Or has a catalog equivalent (catalog tool takes precedence)
    OR name IN (SELECT name FROM tools WHERE catalog_id IS NOT NULL)
  );
--> statement-breakpoint

-- Step 4: Make remaining proxy tools shared (agent_id = NULL).
UPDATE tools
SET agent_id = NULL
WHERE agent_id IS NOT NULL
  AND catalog_id IS NULL
  AND delegate_to_agent_id IS NULL;
