WITH selected_teams AS MATERIALIZED (
    SELECT id, organization_id FROM team WHERE id = ANY($2)
), entity_refs (entity_type, entity_id) AS (
    SELECT 'agent', $1::uuid::text
    UNION ALL
    SELECT "entityType", "entityId"
    FROM jsonb_to_recordset($3) AS entity("entityType" text, "entityId" text)
    UNION ALL
    SELECT 'organization', organization_id FROM agents
    WHERE id = $1 AND deleted_at IS NULL AND cardinality($2) = 0
    UNION ALL
    SELECT 'team', id FROM selected_teams
    UNION ALL
    (SELECT 'organization', organization_id FROM selected_teams LIMIT 1)
), matched AS (
    SELECT l.id, count(*)::integer AS refs
    FROM limits l JOIN entity_refs r ON r.entity_type = l.entity_type AND r.entity_id = l.entity_id
    WHERE l.limit_type = 'token_cost' AND l.cleanup_interval <> 'minute'
      AND (l.model ? $4 OR l.model IS NULL)
    GROUP BY l.id
)
INSERT INTO limit_model_usage (limit_id, model, current_usage_tokens_in, current_usage_tokens_out)
SELECT id, $4, refs * $5, refs * $6 FROM matched ORDER BY id
ON CONFLICT (limit_id, model) DO UPDATE SET
    current_usage_tokens_in = limit_model_usage.current_usage_tokens_in + excluded.current_usage_tokens_in,
    current_usage_tokens_out = limit_model_usage.current_usage_tokens_out + excluded.current_usage_tokens_out,
    updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
