-- Organization limits replace budgets targeting the LLM Proxy.
-- Include retired proxy rows; dependent usage counters and labels are removed automatically.
DELETE FROM "limits"
USING "agents"
WHERE "limits"."entity_type" = 'agent'
  AND "limits"."entity_id" = "agents"."id"::text
  AND "limits"."limit_type" = 'token_cost'
  AND "agents"."agent_type" = 'llm_proxy';
