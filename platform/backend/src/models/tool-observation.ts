import {
  type ClientFilter,
  clientForExternalAgentIds,
  TimeInMs,
} from "@archestra/shared";
import { and, eq, inArray } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import { isProxyDiscoveredTool } from "@/database/schemas/tool";
import logger from "@/logging";

export type ProxyToolObservation = {
  toolId: string;
  toolName: string;
  userId: string;
  externalAgentId: string;
  observedAt: Date;
};

class ToolObservationModel {
  /**
   * Record that a user's proxy request carried these tool names, attributed to
   * the request's client app. One row per (tool, user, client); repeat
   * sightings are deduped by an in-memory cache so the proxy hot path only
   * touches the database for triples it has not recorded yet.
   */
  static async recordObservations(params: {
    toolNames: string[];
    userId: string;
    externalAgentId?: string | null;
  }): Promise<void> {
    const externalAgentId = params.externalAgentId ?? "";
    const unseenNames = [...new Set(params.toolNames)].filter(
      (name) =>
        !recordedObservationsCache.has(
          observationCacheKey(name, params.userId, externalAgentId),
        ),
    );
    if (unseenNames.length === 0) {
      return;
    }

    // Only proxy-discovered rows are observed: a catalog, delegation or
    // soft-deleted row that happens to share a name is not what the client
    // declared.
    const tools = await db
      .select({ id: schema.toolsTable.id, name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(
        and(
          inArray(schema.toolsTable.name, unseenNames),
          isProxyDiscoveredTool(schema.toolsTable),
        ),
      );
    if (tools.length === 0) {
      return;
    }

    await db
      .insert(schema.toolObservationsTable)
      .values(
        tools.map((tool) => ({
          toolId: tool.id,
          userId: params.userId,
          externalAgentId,
        })),
      )
      .onConflictDoNothing();

    for (const tool of tools) {
      recordedObservationsCache.set(
        observationCacheKey(tool.name, params.userId, externalAgentId),
        true,
      );
    }

    logger.debug(
      {
        userId: params.userId,
        externalAgentId,
        toolCount: tools.length,
      },
      "[toolObservation] recorded tool observations",
    );
  }

  /**
   * Every observation of a proxy-discovered tool by a member of the
   * organization, with the tool's name and the client that declared it. The
   * detected-server view is derived from these rows; observations carry no
   * organization of their own, so membership of the observer scopes them.
   */
  static async listProxyToolObservations(
    organizationId: string,
  ): Promise<ProxyToolObservation[]> {
    return db
      .select({
        toolId: schema.toolsTable.id,
        toolName: schema.toolsTable.name,
        userId: schema.toolObservationsTable.userId,
        externalAgentId: schema.toolObservationsTable.externalAgentId,
        observedAt: schema.toolObservationsTable.createdAt,
      })
      .from(schema.toolObservationsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.toolsTable.id, schema.toolObservationsTable.toolId),
      )
      .innerJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.toolObservationsTable.userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .where(isProxyDiscoveredTool(schema.toolsTable));
  }

  /**
   * Filter options for the guardrails page: the users who have observed tools,
   * and the client families (Claude, Codex, …) their observations map to.
   */
  static async getObserverFilterOptions(): Promise<{
    users: Array<{ id: string; name: string; email: string }>;
    clients: ClientFilter[];
  }> {
    const [userRows, clientRows] = await Promise.all([
      db
        .selectDistinct({
          id: schema.toolObservationsTable.userId,
          name: schema.usersTable.name,
          email: schema.usersTable.email,
        })
        .from(schema.toolObservationsTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.usersTable.id, schema.toolObservationsTable.userId),
        )
        .orderBy(schema.usersTable.name),
      db
        .selectDistinct({
          externalAgentId: schema.toolObservationsTable.externalAgentId,
        })
        .from(schema.toolObservationsTable),
    ]);

    const clients = new Set<ClientFilter>();
    for (const row of clientRows) {
      const family = clientForExternalAgentIds([row.externalAgentId]);
      if (family) {
        clients.add(family.filter);
      }
    }

    return { users: userRows, clients: [...clients] };
  }
}

export default ToolObservationModel;

// === Internal helpers ===

// Dedupes hot-path writes: a triple recorded once (or found recorded) is
// skipped without a query until it ages out. Re-recording after eviction is
// harmless — the insert is ON CONFLICT DO NOTHING.
const recordedObservationsCache = new LRUCacheManager<boolean>({
  maxSize: 50_000,
  defaultTtl: TimeInMs.Hour * 6,
});

function observationCacheKey(
  toolName: string,
  userId: string,
  externalAgentId: string,
): string {
  return `${toolName}|${userId}|${externalAgentId}`;
}
