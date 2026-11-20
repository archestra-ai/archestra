WITH locked_limits AS MATERIALIZED (
    SELECT l.id, l.model
    FROM limits l
    WHERE l.limit_type = 'token_cost' AND l.cleanup_interval <> 'minute'
      AND EXISTS (
          SELECT FROM jsonb_to_recordset($1) AS entity("entityType" text, "entityId" text)
          WHERE entity."entityType" = l.entity_type AND entity."entityId" = l.entity_id
      )
    ORDER BY l.id
    FOR NO KEY UPDATE
), deltas AS MATERIALIZED (
    SELECT l.id, component.model,
           sum(component."inputTokens")::bigint AS tokens_in,
           sum(component."outputTokens")::bigint AS tokens_out,
           sum(component.cost::numeric) AS cost
    FROM locked_limits l
    CROSS JOIN jsonb_to_recordset($2->'components')
      AS component(model text, "inputTokens" bigint, "outputTokens" bigint, cost text, "modelAliases" jsonb)
    WHERE l.model IS NULL OR l.model = '[]'::jsonb OR l.model ? component.model
       OR l.model ?| ARRAY(SELECT jsonb_array_elements_text(component."modelAliases"))
    GROUP BY l.id, component.model
), legacy AS (
    INSERT INTO limit_model_usage (limit_id, model, current_usage_tokens_in, current_usage_tokens_out)
    SELECT id, model, tokens_in, tokens_out FROM deltas ORDER BY id, model
    ON CONFLICT (limit_id, model) DO UPDATE SET
        current_usage_tokens_in = limit_model_usage.current_usage_tokens_in + excluded.current_usage_tokens_in,
        current_usage_tokens_out = limit_model_usage.current_usage_tokens_out + excluded.current_usage_tokens_out,
        updated_at = now()
)
INSERT INTO limit_billing_usage (limit_id, model, covered_tokens_in, covered_tokens_out, cost, incomplete)
SELECT id, model, tokens_in, tokens_out, cost,
    (($2->'issues') ?| ARRAY['estimated_model_price', 'estimated_cache_price', 'unpriced_usage'])::int
FROM deltas ORDER BY id, model
ON CONFLICT (limit_id, model) DO UPDATE SET
    covered_tokens_in = limit_billing_usage.covered_tokens_in + excluded.covered_tokens_in,
    covered_tokens_out = limit_billing_usage.covered_tokens_out + excluded.covered_tokens_out,
    cost = limit_billing_usage.cost + excluded.cost,
    incomplete = limit_billing_usage.incomplete + excluded.incomplete
