import { type SQL, sql } from "drizzle-orm";
import db from "@/database";
import {
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import { McpServerAgentUsageSchema } from "@/types/mcp-server";
import { AgentUsagePositionSchema } from "@/types/mcp-server-agent-usage";

type Parameters = {
  organizationId: string;
  visibleAgentIds?: string[];
  search?: string;
  sortDirection: "asc" | "desc";
  catalogId?: string;
  serverIds: string[];
  limit: number;
  cursor?: string;
  afterAgentId?: string;
  candidateLimit?: number;
};

class McpServerAgentUsageModel {
  static async count(params: Parameters) {
    const result = await db.execute(
      McpServerAgentUsageModel.countQuery(params),
    );
    return Number(result.rows[0].total);
  }

  static async find(params: Parameters) {
    let cursor = decodeCursor(params.cursor);
    if (params.afterAgentId) {
      // A mixed assigned/automatic page can end on an assigned agent. Resolve
      // that boundary without putting sort keys or opaque cursor encoding in UI.
      const boundary = await db.execute(sql`
        SELECT a.id, a.name, COALESCE(u.email, '') AS email
        FROM agents a LEFT JOIN "user" u ON u.id = a.author_id
        WHERE a.id = ${params.afterAgentId}::uuid AND a.deleted_at IS NULL
          ${McpServerAgentUsageModel.visibleCondition(params)}
          AND ((a.organization_id = ${params.organizationId} AND a.access_all_tools)
            OR ${McpServerAgentUsageModel.assignedCondition(params)})
        LIMIT 1
      `);
      const row = boundary.rows[0];
      cursor = row
        ? {
            id: String(row.id),
            value: JSON.stringify({ name: row.name, email: row.email }),
          }
        : null;
    }
    let position: { name: string; email: string; id: string } | undefined;
    if (cursor) {
      try {
        const parsed = AgentUsagePositionSchema.safeParse({
          ...JSON.parse(cursor.value),
          id: cursor.id,
        });
        if (parsed.success) position = parsed.data;
      } catch {
        /* An invalid cursor starts a fresh page. */
      }
    }
    const hasExclusions = !!params.catalogId && params.serverIds.length > 0;
    let result = await db.execute(
      McpServerAgentUsageModel.query(
        {
          ...params,
          candidateLimit: hasExclusions
            ? Math.max(100, params.limit * 4)
            : undefined,
        },
        position,
      ),
    );
    if (hasExclusions && result.rows.length <= params.limit) {
      // A prefix with too few survivors cannot prove the end of this feed.
      // Retry once without a candidate bound; page contents stay exact.
      result = await db.execute(
        McpServerAgentUsageModel.query(params, position),
      );
    }
    const rows = result.rows.map((row) => McpServerAgentUsageSchema.parse(row));
    return createCursorPaginatedResult(rows, params, (row) => ({
      id: row.id,
      value: JSON.stringify({ name: row.name, email: row.ownerEmail ?? "" }),
    }));
  }

  private static countQuery(params: Parameters): SQL {
    return sql`
      SELECT count(*)::integer AS total
      FROM agents a LEFT JOIN "user" u ON u.id = a.author_id
      WHERE ${McpServerAgentUsageModel.automaticCondition(params)}
    `;
  }

  private static query(
    params: Parameters,
    position?: { name: string; email: string; id: string },
  ): SQL {
    const direction = params.sortDirection === "desc" ? sql`DESC` : sql`ASC`;
    const comparison = params.sortDirection === "desc" ? sql`<` : sql`>`;
    const after = position
      ? sql`AND (a.name COLLATE "C", COALESCE(u.email, '') COLLATE "C", a.id)
          ${comparison} (${position.name} COLLATE "C", ${position.email} COLLATE "C", ${position.id}::uuid)`
      : sql``;
    const automatic = sql`
      SELECT a.id, a.name, a.agent_type AS "agentType", a.scope,
        a.author_id AS "ownerId", u.email AS "ownerEmail",
        a.name COLLATE "C" AS sort_name, COALESCE(u.email, '') COLLATE "C" AS sort_owner
      FROM agents a LEFT JOIN "user" u ON u.id = a.author_id
      WHERE ${McpServerAgentUsageModel.automaticCondition(params)} ${after}
      ORDER BY sort_name ${direction}, sort_owner ${direction}, a.id ${direction}`;
    if (!params.catalogId || params.serverIds.length === 0) {
      // With nothing to exclude, PostgreSQL can use a bounded top-N sort.
      return sql`${automatic} LIMIT ${params.limit + 1}`;
    }
    // A bounded ordered prefix handles sparse exclusions without spilling a
    // full-roster sort. The caller retries unbounded only if it cannot fill
    // the page, so a dense assignment set never truncates the feed.
    return sql`
      WITH automatic AS MATERIALIZED (
        ${automatic} ${params.candidateLimit ? sql`LIMIT ${params.candidateLimit}` : sql``}
      )
      SELECT * FROM automatic a
      WHERE NOT ${McpServerAgentUsageModel.assignedCondition(params)}
      ORDER BY sort_name ${direction}, sort_owner ${direction}, id ${direction}
      LIMIT ${params.limit + 1}
    `;
  }

  private static automaticCondition(params: Parameters): SQL {
    const searchTerm = params.search?.replace(/[\\%_]/g, "\\$&");
    return sql`a.organization_id = ${params.organizationId}
      AND a.deleted_at IS NULL AND a.access_all_tools
      ${McpServerAgentUsageModel.visibleCondition(params)}
      ${searchTerm ? sql`AND (a.name ILIKE ${`%${searchTerm}%`} ESCAPE '\\' OR COALESCE(u.email, '') ILIKE ${`%${searchTerm}%`} ESCAPE '\\')` : sql``}`;
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  private static visibleCondition(params: Parameters): SQL {
    return params.visibleAgentIds
      ? sql`AND a.id = ANY(${sql.param(params.visibleAgentIds)}::uuid[])`
      : sql``;
  }
  // SPDX-SnippetEnd

  private static assignedCondition(params: Parameters): SQL {
    if (!params.catalogId || params.serverIds.length === 0) return sql`false`;
    return sql`COALESCE((
      SELECT true FROM agent_tools at
      LEFT JOIN tools t ON at.mcp_server_id IS NULL AND t.id = at.tool_id
      WHERE at.agent_id = a.id AND (
        at.mcp_server_id = ANY(${sql.param(params.serverIds)}::uuid[]) OR
        (at.mcp_server_id IS NULL AND t.catalog_id = ${params.catalogId}::uuid)
      ) LIMIT 1
    ), false)`;
  }
}

export default McpServerAgentUsageModel;
