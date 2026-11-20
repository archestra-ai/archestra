-- Match usageFactsQuery in backend/src/models/llm-usage-rollup.ts.
INSERT INTO llm_usage_hourly (
    hour, profile_id, connector_id, app_id, billing_team_id, user_id,
    service_account_id, auth_method, virtual_key_id, passthrough_virtual_key_id,
    authenticated_app_id, authenticated_app_name, provider_api_key_id,
    model_pool_id, external_agent_id, type, model, billed_model, billing_mode,
    attribution_labels, requests, input_tokens, reported_input_tokens,
    output_tokens, cache_read_tokens, cache_write_tokens, cost, baseline_cost,
    cache_savings, failed_over_attempts, max_created_at, model_input_tokens,
    model_reported_input_tokens, model_output_tokens, model_cache_read_tokens,
    model_cache_write_tokens, model_cost, model_baseline_cost, model_cache_savings
)
SELECT $1, i.profile_id, i.connector_id, i.app_id, i.billing_team_id, i.user_id,
    i.service_account_id, i.auth_method, i.virtual_key_id, i.passthrough_virtual_key_id,
    i.authenticated_app_id, i.authenticated_app_name, i.provider_api_key_id,
    i.model_pool_id, i.external_agent_id, i.type, i.model, COALESCE(m.model, i.model),
    i.billing_mode, COALESCE(r.attribution_labels, i.attribution_labels),
    count(*) FILTER (WHERE p.own),
    COALESCE(sum(i.input_tokens) FILTER (WHERE p.own), 0),
    COALESCE(sum(i.input_tokens) FILTER (WHERE p.own AND NOT i.input_tokens_estimated), 0),
    COALESCE(sum(i.output_tokens) FILTER (WHERE p.own), 0),
    COALESCE(sum(i.cache_read_tokens) FILTER (WHERE p.own), 0),
    COALESCE(sum(i.cache_write_tokens) FILTER (WHERE p.own), 0),
    COALESCE(sum(i.cost) FILTER (WHERE p.own), 0),
    COALESCE(sum(i.baseline_cost) FILTER (WHERE p.own), 0),
    COALESCE(sum(i.cache_savings) FILTER (WHERE p.own), 0),
    count(*) FILTER (WHERE p.own AND i.attempt_outcome = 'failed_over'),
    max(i.created_at) FILTER (WHERE p.own),
    COALESCE(sum(COALESCE(m.input_tokens, i.input_tokens)), 0),
    COALESCE(sum(COALESCE(m.input_tokens, CASE WHEN NOT i.input_tokens_estimated THEN i.input_tokens ELSE 0 END)), 0),
    COALESCE(sum(COALESCE(m.output_tokens, i.output_tokens)), 0),
    COALESCE(sum(COALESCE(m.cache_read_tokens, i.cache_read_tokens)), 0),
    COALESCE(sum(COALESCE(m.cache_write_tokens, i.cache_write_tokens)), 0),
    COALESCE(sum(COALESCE(m.cost, i.cost)), 0),
    COALESCE(sum(COALESCE(m.cost, i.baseline_cost)), 0),
    COALESCE(sum(COALESCE(m.cache_savings, i.cache_savings)), 0)
FROM interactions AS i
LEFT JOIN interaction_billing AS r ON r.interaction_id = i.id
LEFT JOIN LATERAL (
    SELECT component->>'model' AS model,
        bool_or(component->>'model' = COALESCE(
            jsonb_path_query_first(r.usage, '$.components[*] ? (@.kind == "message")')->>'model',
            r.usage->'components'->0->>'model'
        )) AS parent_request,
        sum((component->>'inputTokens')::bigint) AS input_tokens,
        sum((component->>'outputTokens')::bigint) AS output_tokens,
        sum((component->>'cacheReadTokens')::bigint) AS cache_read_tokens,
        sum((component->>'cacheWriteTokens')::bigint) AS cache_write_tokens,
        sum((component->>'cost')::numeric) AS cost,
        sum(round((
            COALESCE((component->>'cacheReadTokens')::numeric * ((component->'prices'->>'input')::numeric - (component->'prices'->>'cacheRead')::numeric), 0)
            + CASE WHEN component->'prices'->>'cacheWrite' IS NULL THEN 0 ELSE
                (component->>'cacheWriteTokens')::numeric * (component->'prices'->>'input')::numeric
                - ((component->>'cacheWriteTokens')::numeric - (component->>'cacheWrite1hTokens')::numeric) * (component->'prices'->>'cacheWrite')::numeric
                - (component->>'cacheWrite1hTokens')::numeric * COALESCE((component->'prices'->>'cacheWrite1h')::numeric, 0)
              END
        ) / 1000000, 10)) AS cache_savings
    FROM jsonb_array_elements(CASE WHEN r.usage->>'mode' = 'enforce' THEN r.usage->'components' END) AS component
    GROUP BY component->>'model'
) AS m ON true
CROSS JOIN LATERAL (SELECT m.model IS NULL OR m.parent_request AS own) AS p
WHERE i.created_at >= $1 AND i.created_at < $1 + interval '1 hour'
GROUP BY 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20
