WITH updated AS (
    UPDATE team t SET
        name = coalesce($3->>'name', t.name),
        description = CASE WHEN $3 ? 'description' THEN $3->>'description' ELSE t.description END,
        parent_team_id = CASE WHEN $3 ? 'parentId' THEN $3->>'parentId' ELSE t.parent_team_id END,
        -- SPDX-SnippetBegin
        -- SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        -- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        roles = CASE WHEN $3 ? 'roles' THEN ARRAY(SELECT jsonb_array_elements_text($3->'roles')) ELSE t.roles END,
        -- SPDX-SnippetEnd
        updated_at = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
    WHERE t.id = $1 AND t.organization_id = $2
        AND ($3->>'parentId' IS NULL OR EXISTS (
            SELECT 1 FROM team p WHERE p.id = $3->>'parentId' AND p.organization_id = $2
        ))
    RETURNING t.*
)
SELECT t.id, t.name, t.description, t.roles, t.parent_team_id AS parent_id, t.organization_id, t.created_by,
    to_char(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
    to_char(t.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
    (SELECT count(*) FROM team_member WHERE team_id = t.id) AS member_count
FROM updated t
