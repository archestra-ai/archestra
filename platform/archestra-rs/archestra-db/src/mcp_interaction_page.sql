WITH matching AS NOT MATERIALIZED (
    SELECT i.*, CASE WHEN a.deleted_at IS NULL THEN a.id END AS active_profile_id
    FROM interactions i
    LEFT JOIN agents a ON a.id = i.profile_id AND a.organization_id = $1
    WHERE COALESCE(i.profile_id, i.connector_id, i.app_id) IS NOT NULL
      AND (i.profile_id IS NULL OR a.id IS NOT NULL)
      AND (i.connector_id IS NULL OR EXISTS (
          SELECT 1 FROM knowledge_base_connectors c WHERE c.id = i.connector_id AND c.organization_id = $1
      ))
      AND (i.app_id IS NULL OR EXISTS (
          SELECT 1 FROM apps p WHERE p.id = i.app_id AND p.organization_id = $1
      ))
      AND ($2::text IS NULL OR i.user_id = $2)
      AND ($3::uuid IS NULL OR i.profile_id = $3)
      AND ($4::text IS NULL OR i.external_agent_id = $4)
      AND ($5::text IS NULL OR i.session_id = $5 OR (i.session_id IS NULL AND i.id = $6))
      AND ($7::text IS NULL OR i.created_at >= $7::timestamp)
      AND ($8::text IS NULL OR i.created_at <= $8::timestamp)
), page AS MATERIALIZED (
    SELECT * FROM matching ORDER BY created_at DESC, id DESC LIMIT $9 OFFSET $10
)
SELECT (SELECT count(*) FROM matching) AS total,
    ARRAY(
        SELECT json_build_object(
            'id', i.id, 'profileId', i.active_profile_id, 'externalAgentId', i.external_agent_id,
            'sessionId', i.session_id, 'type', i.type, 'model', i.model, 'baselineModel', i.baseline_model,
            'billingMode', i.billing_mode, 'inputTokens', i.input_tokens,
            'inputTokensEstimated', i.input_tokens_estimated, 'outputTokens', i.output_tokens,
            'cacheReadTokens', i.cache_read_tokens, 'cacheWriteTokens', i.cache_write_tokens,
            'cost', i.cost::text, 'baselineCost', i.baseline_cost::text, 'durationMs', i.duration_ms,
            'createdAt', to_char(i.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'providerApiKeyId', i.provider_api_key_id, 'modelPoolId', i.model_pool_id,
            'attempt', i.attempt, 'attemptOutcome', i.attempt_outcome, 'failureReason', i.failure_reason,
            'source', i.source,
            'autoRouted', EXISTS (SELECT 1 FROM routing_usage r WHERE r.interaction_id = i.id),
            'attributionLabels', i.attribution_labels, 'sessionPreview', i.session_preview,
            'encryptedChatConversationId', i.encrypted_chat_conversation_id,
            'requestType', CASE
                WHEN i.source IN ('opencode:main', 'kilo:main') THEN 'main'
                WHEN i.source IN ('opencode:subagent', 'opencode:title', 'opencode:compaction', 'kilo:subagent', 'kilo:title', 'kilo:compaction')
                  OR i.source LIKE 'guardrail:%' THEN 'subagent'
                WHEN i.session_source IN ('opencode_session', 'kilo_session')
                  AND lower(concat_ws(E'\n', i.request->>'system', i.request->>'instructions',
                    i.request#>>'{systemInstruction,parts,0,text}')) LIKE '%title generator%' THEN 'subagent'
                WHEN i.session_source IN ('opencode_session', 'kilo_session')
                  AND i.request ? 'tools'
                  AND NOT EXISTS (
                      SELECT 1 FROM jsonb_array_elements(coalesce(i.request->'tools', '[]'::jsonb)) tool
                      WHERE tool->>'name' = 'task' OR tool->'function'->>'name' = 'task'
                        OR EXISTS (
                            SELECT 1 FROM jsonb_array_elements(coalesce(tool->'functionDeclarations', '[]'::jsonb)) declaration
                            WHERE declaration->>'name' = 'task'
                        )
                  ) THEN 'subagent'
                ELSE 'main'
            END
        )::text FROM page i ORDER BY i.created_at DESC, i.id DESC
    ) AS rows
