import { sql } from "drizzle-orm";
import db from "@/database";
import { createPaginatedResult } from "@/database/utils/pagination";
import {
  type McpAgentUsagePage,
  McpAgentUsagePageSchema,
} from "@/types/mcp-server-agent-usage";

class McpServerAgentUsageModel {
  static async find(params: {
    catalogIds: string[];
    serverIds: string[];
    organizationId: string;
    visibleAgentIds?: string[];
    limit: number;
    offset: number;
    search?: string;
    sortDirection: "asc" | "desc";
    previews: boolean;
  }): Promise<McpAgentUsagePage[]> {
    if (params.catalogIds.length === 0) return [];
    const result = await db.execute(McpServerAgentUsageModel.query(params));
    return result.rows.map((row) =>
      McpAgentUsagePageSchema.parse({
        ...row,
        ...createPaginatedResult(
          row.data as McpAgentUsagePage["data"],
          Number(row.total),
          params,
        ),
      }),
    );
  }
  private static query(
    params: Parameters<typeof McpServerAgentUsageModel.find>[0],
  ) {
    const direction = params.sortDirection === "desc" ? sql`DESC` : sql`ASC`;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const visible = params.visibleAgentIds
      ? sql`AND a.id = ANY(${sql.param(params.visibleAgentIds)}::uuid[])`
      : sql``;
    // SPDX-SnippetEnd
    const searchTerm = params.search?.replace(/[\\%_]/g, "\\$&");
    const search = searchTerm
      ? sql`AND (a.name ILIKE ${`%${searchTerm}%`} ESCAPE '\\' OR COALESCE(u.email, '') ILIKE ${`%${searchTerm}%`} ESCAPE '\\')`
      : sql``;
    const common = sql`
      WITH requested AS (
        SELECT unnest(${sql.param(params.catalogIds)}::uuid[]) AS catalog_id
      ), assigned AS MATERIALIZED (
        SELECT s.catalog_id, at.agent_id
        FROM agent_tools at
        JOIN mcp_server s ON s.id = at.mcp_server_id
        WHERE at.mcp_server_id = ANY(${sql.param(params.serverIds)}::uuid[])
        UNION
        SELECT t.catalog_id, at.agent_id
        FROM tools t
        JOIN agent_tools at ON at.tool_id = t.id AND at.mcp_server_id IS NULL
        WHERE t.catalog_id IN (
          SELECT catalog_id FROM mcp_server WHERE id = ANY(${sql.param(params.serverIds)}::uuid[])
        )
      ), eligible_agent_ids AS (
        SELECT id FROM agents WHERE organization_id = ${params.organizationId}
        UNION SELECT agent_id FROM assigned
      ), visible_agents AS MATERIALIZED (
        SELECT a.id, a.organization_id, a.name, a.agent_type, a.scope, a.author_id,
          a.access_all_tools, u.email AS owner_email
        FROM eligible_agent_ids e JOIN agents a ON a.id = e.id
        LEFT JOIN "user" u ON u.id = a.author_id
        WHERE a.deleted_at IS NULL ${visible} ${search}
      )`;
    if (params.previews) {
      return sql`${common}, assigned_agents AS MATERIALIZED (
        SELECT x.catalog_id, a.* FROM assigned x JOIN visible_agents a ON a.id = x.agent_id
      ), assigned_totals AS (
        SELECT catalog_id, count(*)::integer AS total,
          count(*) FILTER (WHERE access_all_tools AND organization_id = ${params.organizationId})::integer AS overlap
        FROM assigned_agents GROUP BY catalog_id
      ), automatic AS MATERIALIZED (
        SELECT * FROM visible_agents WHERE access_all_tools AND organization_id = ${params.organizationId}
      ), auto_total AS (
        SELECT count(*)::integer AS total FROM automatic
      ), auto_candidates AS MATERIALIZED (
        -- A catalog can exclude at most overlap leading auto agents. This
        -- prefix contains its entire requested preview after those exclusions.
        SELECT *, row_number() OVER (ORDER BY name ${direction}, COALESCE(owner_email, '') ${direction}, id ${direction}) AS ordinal FROM automatic
        ORDER BY name ${direction}, COALESCE(owner_email, '') ${direction}, id ${direction}
        LIMIT (${params.limit + params.offset} + COALESCE((SELECT max(overlap) FROM assigned_totals), 0))
      ), ranked_assigned AS (
        SELECT *, row_number() OVER (PARTITION BY catalog_id ORDER BY name ${direction}, COALESCE(owner_email, '') ${direction}, id ${direction}) AS position
        FROM assigned_agents
      ), manual_previews AS (
        SELECT catalog_id, jsonb_agg(jsonb_build_object('id', id, 'name', name, 'agentType', agent_type, 'scope', scope,
          'ownerId', author_id, 'ownerEmail', owner_email, 'access', 'assigned') ORDER BY position) AS entries
        FROM ranked_assigned WHERE position > ${params.offset} AND position <= ${params.offset + params.limit}
        GROUP BY catalog_id
      )
      , auto_only_candidates AS MATERIALIZED (
        SELECT r.catalog_id, a.*
        FROM requested r CROSS JOIN auto_candidates a CROSS JOIN auto_total total
        LEFT JOIN assigned_totals t ON t.catalog_id = r.catalog_id
        WHERE total.total - COALESCE(t.overlap, 0) > ${params.offset}
          AND a.ordinal <= ${params.offset + params.limit} + COALESCE(t.overlap, 0)
          AND NOT EXISTS (
            SELECT 1 FROM assigned x WHERE x.catalog_id = r.catalog_id AND x.agent_id = a.id
          )
      ), ranked_automatic AS (
        SELECT *, row_number() OVER (PARTITION BY catalog_id ORDER BY ordinal) AS position
        FROM auto_only_candidates
      ), automatic_previews AS (
        SELECT catalog_id, jsonb_agg(jsonb_build_object('id', id, 'name', name, 'agentType', agent_type, 'scope', scope,
          'ownerId', author_id, 'ownerEmail', owner_email, 'access', 'auto') ORDER BY position) AS entries
        FROM ranked_automatic WHERE position > ${params.offset} AND position <= ${params.offset + params.limit}
        GROUP BY catalog_id
      )
      SELECT r.catalog_id AS "catalogId", COALESCE(t.total, 0) + automatic.total - COALESCE(t.overlap, 0) AS total,
        COALESCE(t.total, 0) AS "assignedCount", automatic.total - COALESCE(t.overlap, 0) AS "autoCount",
        COALESCE(manual.entries, '[]'::jsonb) || COALESCE(auto.entries, '[]'::jsonb) AS data,
        COALESCE(manual.entries, '[]'::jsonb) AS "assignedPreview", COALESCE(auto.entries, '[]'::jsonb) AS "autoPreview"
      FROM requested r CROSS JOIN auto_total automatic
      LEFT JOIN assigned_totals t ON t.catalog_id = r.catalog_id
      LEFT JOIN manual_previews manual ON manual.catalog_id = r.catalog_id
      LEFT JOIN automatic_previews auto ON auto.catalog_id = r.catalog_id`;
    }
    return sql`${common}, usage AS MATERIALIZED (
        SELECT x.catalog_id, a.*, 'assigned'::text AS access
        FROM assigned x JOIN visible_agents a ON a.id = x.agent_id
        UNION ALL
        SELECT r.catalog_id, a.*, 'auto'::text AS access
        FROM requested r CROSS JOIN visible_agents a
        WHERE a.access_all_tools AND a.organization_id = ${params.organizationId}
          AND NOT EXISTS (SELECT 1 FROM assigned x WHERE x.catalog_id = r.catalog_id AND x.agent_id = a.id)
      ), filtered AS (
        SELECT * FROM usage
      ), ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY catalog_id ${params.previews ? sql`, access` : sql``}
          ORDER BY name ${direction}, COALESCE(owner_email, '') ${direction}, id ${direction}
        ) AS position FROM filtered
      ), totals AS (
        SELECT catalog_id, count(*)::integer AS total,
          count(*) FILTER (WHERE access = 'assigned')::integer AS assigned_count,
          count(*) FILTER (WHERE access = 'auto')::integer AS auto_count
        FROM filtered GROUP BY catalog_id
      ), page AS (
        SELECT catalog_id, access, position, jsonb_build_object(
          'id', id, 'name', name, 'agentType', agent_type, 'scope', scope,
          'ownerId', author_id, 'ownerEmail', owner_email, 'access', access
        ) AS entry FROM ranked
        WHERE position > ${params.offset} AND position <= ${params.offset + params.limit}
      )
      SELECT r.catalog_id AS "catalogId", COALESCE(t.total, 0) AS total,
        COALESCE(t.assigned_count, 0) AS "assignedCount", COALESCE(t.auto_count, 0) AS "autoCount",
        COALESCE(jsonb_agg(p.entry ORDER BY p.position) FILTER (WHERE p.entry IS NOT NULL), '[]'::jsonb) AS data,
        COALESCE(jsonb_agg(p.entry ORDER BY p.position) FILTER (WHERE p.access = 'assigned'), '[]'::jsonb) AS "assignedPreview",
        COALESCE(jsonb_agg(p.entry ORDER BY p.position) FILTER (WHERE p.access = 'auto'), '[]'::jsonb) AS "autoPreview"
      FROM requested r LEFT JOIN totals t ON t.catalog_id = r.catalog_id
      LEFT JOIN page p ON p.catalog_id = r.catalog_id
      GROUP BY r.catalog_id, t.total, t.assigned_count, t.auto_count
    `;
  }
}

export default McpServerAgentUsageModel;
