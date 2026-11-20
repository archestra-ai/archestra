INSERT INTO llm_usage_daily (
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
SELECT date_trunc('day', $1::timestamp),
    profile_id, connector_id, app_id, billing_team_id, user_id,
    service_account_id, auth_method, virtual_key_id, passthrough_virtual_key_id,
    authenticated_app_id, authenticated_app_name, provider_api_key_id,
    model_pool_id, external_agent_id, type, model, billed_model, billing_mode,
    attribution_labels, sum(requests), sum(input_tokens), sum(reported_input_tokens),
    sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens), sum(cost),
    sum(baseline_cost), sum(cache_savings), sum(failed_over_attempts), max(max_created_at),
    sum(model_input_tokens), sum(model_reported_input_tokens), sum(model_output_tokens),
    sum(model_cache_read_tokens), sum(model_cache_write_tokens), sum(model_cost),
    sum(model_baseline_cost), sum(model_cache_savings)
FROM llm_usage_hourly
WHERE hour >= date_trunc('day', $1::timestamp)
    AND hour < date_trunc('day', $1::timestamp) + interval '1 day'
    AND EXISTS (
        SELECT 1 FROM llm_usage_rollup_state
        WHERE id = 1 AND rolled_through >= date_trunc('day', $1::timestamp) + interval '1 day'
    )
GROUP BY 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20
