ALTER TABLE "organization" ADD COLUMN "connection_client_provider_keys" jsonb;--> statement-breakpoint
-- The old defaults applied to every setup command. Keep that: copy them to
-- each client, limited to the providers that client can map.
UPDATE "organization" AS "o"
SET "connection_client_provider_keys" = "mapped"."value"
FROM (
  SELECT "per_client"."id", jsonb_object_agg("per_client"."client_id", "per_client"."keys") AS "value"
  FROM (
    SELECT "org"."id", "clients"."client_id", jsonb_agg(
      jsonb_build_object('provider', "entry"."key", 'providerApiKeyId', "entry"."value")
      ORDER BY "entry"."key"
    ) AS "keys"
    FROM "organization" AS "org"
    CROSS JOIN (VALUES
      ('claude-code', ARRAY['anthropic', 'bedrock']),
      ('claude-desktop', ARRAY['anthropic']),
      ('cursor', ARRAY['openai', 'azure', 'cerebras', 'deepseek', 'groq', 'minimax', 'mistral', 'ollama', 'openrouter', 'perplexity', 'vllm', 'xai', 'zhipuai', 'github-copilot', 'anthropic', 'bedrock', 'cohere', 'gemini']),
      ('codex', ARRAY['openai']),
      ('copilot-cli', ARRAY['openai', 'azure', 'openrouter', 'vllm', 'ollama', 'groq', 'mistral', 'deepseek', 'xai', 'cerebras']),
      ('opencode', ARRAY['openai', 'azure', 'cerebras', 'deepseek', 'groq', 'minimax', 'mistral', 'ollama', 'openrouter', 'perplexity', 'vllm', 'xai', 'zhipuai', 'github-copilot', 'anthropic', 'bedrock', 'cohere', 'gemini', 'kimi', 'archestra'])
    ) AS "clients"("client_id", "providers")
    CROSS JOIN LATERAL jsonb_each("org"."connection_default_provider_keys") AS "entry"
    WHERE jsonb_typeof("org"."connection_default_provider_keys") = 'object'
      AND "entry"."key" = ANY("clients"."providers")
    GROUP BY "org"."id", "clients"."client_id"
  ) AS "per_client"
  GROUP BY "per_client"."id"
) AS "mapped"
WHERE "o"."id" = "mapped"."id";
