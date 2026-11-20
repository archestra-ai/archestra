WITH labels AS (
    INSERT INTO agent_labels (agent_id, key_id, value_id)
    SELECT $1, k.id, v.id FROM jsonb_each_text($3) AS label
    JOIN label_keys k ON k.key = label.key
    JOIN label_values v ON v.value = label.value
    RETURNING 1
), bases AS (
    INSERT INTO agent_knowledge_base (agent_id, knowledge_base_id)
    SELECT $1, id FROM knowledge_bases
    WHERE id = ANY($4) AND organization_id = $2 AND deleted_at IS NULL
    RETURNING 1
), connectors AS (
    INSERT INTO agent_connector_assignment (agent_id, connector_id)
    SELECT $1, id FROM knowledge_base_connectors
    WHERE id = ANY($5) AND organization_id = $2 AND deleted_at IS NULL
    RETURNING 1
), default_tools AS (
    INSERT INTO agent_tools (agent_id, tool_id)
    SELECT $1, id FROM unnest($6::uuid[]) AS tool(id)
    RETURNING 1
)
SELECT (SELECT count(*) FROM labels) + (SELECT count(*) FROM bases)
    + (SELECT count(*) FROM connectors) + (SELECT count(*) FROM default_tools) AS added
