WITH target AS MATERIALIZED (
    SELECT id, latest_version FROM agents
    WHERE id = $1 AND organization_id = $2 AND xmin::text = $3
        AND agent_type = 'mcp_gateway' AND deleted_at IS NULL AND latest_version = $6
    FOR UPDATE
), comparison AS (
    SELECT t.id, t.latest_version, v.content_hash IS NOT DISTINCT FROM $5 AS unchanged
    FROM target t LEFT JOIN agent_versions v
        ON v.agent_id = t.id AND v.version = t.latest_version AND t.latest_version > 0
), advanced AS (
    UPDATE agents a SET latest_version = c.latest_version + 1,
        updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
    FROM comparison c WHERE a.id = c.id AND NOT c.unchanged
    RETURNING a.id, a.latest_version
), inserted AS (
    INSERT INTO agent_versions (agent_id, version, snapshot, content_hash)
    SELECT id, latest_version, $4, $5 FROM advanced RETURNING agent_id, version
), pruned AS (
    DELETE FROM agent_versions v USING inserted i
    WHERE v.agent_id = i.agent_id AND v.version < i.version - $7 + 1
)
SELECT version FROM inserted
UNION ALL
SELECT latest_version FROM comparison WHERE unchanged
