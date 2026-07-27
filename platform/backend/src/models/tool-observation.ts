import {
  type ClientFilter,
  clientForExternalAgentIds,
  TimeInMs,
} from "@archestra/shared";
import { eq, inArray } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import logger from "@/logging";

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

    const tools = await db
      .select({ id: schema.toolsTable.id, name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.name, unseenNames));
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
