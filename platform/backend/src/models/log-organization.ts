import { and, eq, exists, isNull, or, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Keep interaction reads inside the active organization. Interactions do not
 * duplicate an organization id, so their owning agent, knowledge connector,
 * or app is the tenant boundary.
 */
export function interactionBelongsToOrganization(organizationId: string): SQL {
  const agentBelongsToOrganization = exists(
    db
      .select({ value: sql`1` })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, schema.interactionsTable.profileId),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      ),
  );
  const connectorBelongsToOrganization = exists(
    db
      .select({ value: sql`1` })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorsTable.id,
            schema.interactionsTable.connectorId,
          ),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
        ),
      ),
  );
  const appBelongsToOrganization = exists(
    db
      .select({ value: sql`1` })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.id, schema.interactionsTable.appId),
          eq(schema.appsTable.organizationId, organizationId),
        ),
      ),
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
