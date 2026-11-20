SELECT json_build_object(
    'sessionId', max(i.session_id), 'sessionSource', max(i.session_source),
    'source', CASE WHEN count(DISTINCT i.source) = 1 THEN max(i.source) END,
    'sources', array_remove(array_agg(DISTINCT i.source ORDER BY i.source), NULL),
    'interactionId', CASE WHEN max(i.session_id) IS NULL THEN max(i.id::text) END,
    'requestCount', count(*),
    'failedOverCount', count(*) FILTER (WHERE i.attempt_outcome = 'failed_over'),
    'totalDurationMs', sum(i.duration_ms)::text,
    'totalInputTokens', sum(i.input_tokens)::text, 'totalOutputTokens', sum(i.output_tokens)::text,
    'totalCacheReadTokens', sum(i.cache_read_tokens)::text, 'totalCacheWriteTokens', sum(i.cache_write_tokens)::text,
    'totalCost', sum(i.cost)::text,
    'totalBilledCost', (sum(i.cost) FILTER (WHERE i.billing_mode = 'metered'))::text,
    'totalSubscriptionCost', (sum(i.cost) FILTER (WHERE i.billing_mode = 'subscription'))::text,
    'totalBaselineCost', sum(i.baseline_cost)::text, 'totalCacheSavings', sum(i.cache_savings)::text,
    'firstRequestTime', to_char(min(i.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastRequestTime', to_char(max(i.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'models', string_agg(DISTINCT i.model, ','),
    'profileId', coalesce(max(a.id::text) FILTER (WHERE a.built_in = false), max(a.id::text)),
    'profileName', coalesce(max(a.name) FILTER (WHERE a.built_in = false), max(a.name)),
    'profileAgentType', coalesce(max(a.agent_type::text) FILTER (WHERE a.built_in = false), max(a.agent_type::text)),
    'externalAgentIds', string_agg(DISTINCT i.external_agent_id, ','),
    'authMethods', string_agg(DISTINCT i.auth_method, ','),
    'authenticatedAppNames', array_remove(array_agg(DISTINCT i.authenticated_app_name), NULL),
    'userNames', array_remove(array_agg(DISTINCT u.name ORDER BY u.name), NULL),
    'userIds', array_remove(array_agg(DISTINCT u.id), NULL),
    'virtualKeyIds', array_remove(array_agg(DISTINCT i.virtual_key_id::text), NULL),
    'copilotProviderApiKeyIds', array_remove(array_agg(DISTINCT i.provider_api_key_id::text) FILTER (WHERE i.type LIKE 'github-copilot:%'), NULL),
    'passthroughVirtualKeyIds', array_remove(array_agg(DISTINCT i.passthrough_virtual_key_id::text), NULL),
    'conversationTitle', (
        SELECT c.title FROM conversations c WHERE c.id = CASE
            WHEN max(i.session_id) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN max(i.session_id)::uuid END
    ),
    'connectorName', CASE WHEN count(DISTINCT i.connector_id) = 1 THEN (
        SELECT c.name FROM knowledge_base_connectors c WHERE c.id = max(i.connector_id::text)::uuid
    ) END
)::text AS data
FROM interactions i
LEFT JOIN agents a ON a.id = i.profile_id AND a.deleted_at IS NULL
LEFT JOIN "user" u ON u.id = i.user_id
WHERE {scope} AND (i.session_id = ANY($8::text[]) OR i.id = ANY($9::text[]::uuid[]))
GROUP BY coalesce(i.session_id, i.id::text)
