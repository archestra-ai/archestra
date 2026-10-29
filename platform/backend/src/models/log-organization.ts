import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Keep interaction reads inside the active organization. Interactions do not
 * duplicate an organization id, so their owning agent, knowledge connector,
 * or app is the tenant boundary.
 */
export function interactionBelongsToOrganization(organizationId: string): SQL {
  const t = schema.interactionsTable;
  // Correlated EXISTS lets PostgreSQL pick per query between hashing the
  // organization's owners once (a wide log scan) and probing each row's owner
  // by primary key (one session's few rows); an uncorrelated set is always
  // hashed in full, which costs more than the rows it filters on a large
  // organization. Each owner table appears once, so it is read at most once.
  const owns = (
    ownerTable:
      | typeof schema.agentsTable
      | typeof schema.knowledgeBaseConnectorsTable
      | typeof schema.appsTable,
    ownerId: typeof t.profileId | typeof t.connectorId | typeof t.appId,
  ) =>
    or(
      isNull(ownerId),
      exists(
        db
          .select({ value: sql`1` })
          .from(ownerTable)
          .where(
            and(
              eq(ownerTable.id, ownerId),
              eq(ownerTable.organizationId, organizationId),
            ),
          ),
      ),
    );

  // Every owner the row names belongs here, and it names at least one.
  return and(
    or(isNotNull(t.profileId), isNotNull(t.connectorId), isNotNull(t.appId)),
    owns(schema.agentsTable, t.profileId),
    owns(schema.knowledgeBaseConnectorsTable, t.connectorId),
    owns(schema.appsTable, t.appId),
  ) as SQL;
}

/**
 * Keep MCP tool-call reads inside the active organization. Tool calls belong
 * to either an agent or an app, and intentionally outlive soft deletion.
 */
export function mcpToolCallBelongsToOrganization(organizationId: string): SQL {
  const agentBelongsToOrganization = exists(
    db
      .select({ value: sql`1` })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, schema.mcpToolCallsTable.agentId),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      ),
  );
  const appBelongsToOrganization = exists(
    db
      .select({ value: sql`1` })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.id, schema.mcpToolCallsTable.appId),
          eq(schema.appsTable.organizationId, organizationId),
        ),
      ),
  );

  return or(
    and(
      eq(schema.mcpToolCallsTable.ownerType, "agent"),
      agentBelongsToOrganization,
    ),
    and(
      eq(schema.mcpToolCallsTable.ownerType, "app"),
      appBelongsToOrganization,
    ),
  ) as SQL;
}
