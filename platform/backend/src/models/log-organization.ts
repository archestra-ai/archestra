import {
  and,
  eq,
  exists,
  inArray,
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
  // Uncorrelated membership sets let PostgreSQL build each owner set once,
  // rather than probing owner tables for every row in the interaction log.
  const agentBelongsToOrganization = inArray(
    schema.interactionsTable.profileId,
    db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.organizationId, organizationId)),
  );
  const connectorBelongsToOrganization = inArray(
    schema.interactionsTable.connectorId,
    db
      .select({ id: schema.knowledgeBaseConnectorsTable.id })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
      ),
  );
  const appBelongsToOrganization = inArray(
    schema.interactionsTable.appId,
    db
      .select({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .where(eq(schema.appsTable.organizationId, organizationId)),
  );

  return and(
    or(
      agentBelongsToOrganization,
      connectorBelongsToOrganization,
      appBelongsToOrganization,
    ),
    or(isNull(schema.interactionsTable.profileId), agentBelongsToOrganization),
    or(
      isNull(schema.interactionsTable.connectorId),
      connectorBelongsToOrganization,
    ),
    or(isNull(schema.interactionsTable.appId), appBelongsToOrganization),
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
