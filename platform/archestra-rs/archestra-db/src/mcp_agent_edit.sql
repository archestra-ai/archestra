WITH previous AS MATERIALIZED (
    SELECT id, access_all_tools FROM agents
    WHERE id = $1 AND organization_id = $2 AND agent_type = $8
        AND is_personal_gateway = $5 AND deleted_at IS NULL
        AND (NOT $7 OR NOT access_all_tools)
    FOR UPDATE
), edited AS (
    UPDATE agents AS a SET
        name = coalesce($6->>'name', a.name),
        description = CASE WHEN $6 ? 'description' THEN $6->>'description' ELSE a.description END,
        icon = CASE WHEN $6 ? 'icon' THEN $6->>'icon' ELSE a.icon END,
        access_all_tools = coalesce(($6->>'access_all_tools')::boolean, a.access_all_tools),
        tool_exposure_mode = CASE
            WHEN coalesce(($6->>'access_all_tools')::boolean, a.access_all_tools) THEN 'search_and_run_only'
            ELSE coalesce($6->>'tool_exposure_mode', a.tool_exposure_mode)
        END,
        access_all_subagents = coalesce(($6->>'access_all_subagents')::boolean, a.access_all_subagents),
        subagent_load_balancing = CASE WHEN $6 ? 'subagent_load_balancing'
            THEN nullif($6->'subagent_load_balancing', 'null'::jsonb) ELSE a.subagent_load_balancing END,
        system_prompt = CASE WHEN $8 = 'agent' AND $6 ? 'system_prompt'
            THEN $6->>'system_prompt' ELSE a.system_prompt END,
        runtime = CASE WHEN $8 = 'agent' AND $6 ? 'runtime'
            THEN nullif($6->'runtime', 'null'::jsonb) ELSE a.runtime END,
        network_policy = CASE WHEN $8 = 'agent' AND $6 ? 'network_policy'
            THEN nullif($6->'network_policy', 'null'::jsonb) ELSE a.network_policy END,
        llm_api_key_id = CASE WHEN $8 = 'agent' AND $6 ? 'llm_api_key_id'
            THEN ($6->>'llm_api_key_id')::uuid ELSE a.llm_api_key_id END,
        model_id = CASE WHEN $8 = 'agent' AND $6 ? 'model_id'
            THEN ($6->>'model_id')::uuid ELSE a.model_id END,
        updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
    FROM previous p WHERE a.id = p.id
    RETURNING a.*
), prefill AS (
    INSERT INTO agent_excluded_tools (agent_id, tool_id)
    SELECT g.id, t.id FROM edited g JOIN previous p USING (id) CROSS JOIN tools t
    WHERE g.access_all_tools AND NOT p.access_all_tools
        AND t.catalog_id = $3 AND t.agent_id IS NULL AND t.delegate_to_agent_id IS NULL
        AND NOT (t.name = ANY($4))
        AND NOT EXISTS (
            SELECT 1 FROM agent_tools a WHERE a.agent_id = g.id AND a.tool_id = t.id
        )
    ON CONFLICT DO NOTHING
)
SELECT edited.id, row_to_json(edited)::text AS agent FROM edited
