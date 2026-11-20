WITH created AS (
    INSERT INTO team (id, name, description,
        -- SPDX-SnippetBegin
        -- SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        -- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        roles,
        -- SPDX-SnippetEnd
        organization_id, parent_team_id,
        created_by, created_by_service_account_id, created_at, updated_at)
    SELECT $1, $2, nullif($3, ''), $4, $5, $6, $7, $8, stamp.at, stamp.at
    FROM (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS at) stamp
    WHERE ($6 IS NULL OR EXISTS (
        SELECT 1 FROM team WHERE id = $6 AND organization_id = $5
    ))
    RETURNING id, created_by, created_at
), membership AS (
    INSERT INTO team_member (id, team_id, user_id, role, created_at)
    SELECT $9, id, created_by, 'admin', created_at FROM created WHERE created_by IS NOT NULL
)
SELECT id FROM created
