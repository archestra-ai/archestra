import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

export type AuditSnapshot = {
  /** Human label for the object, if available */
  name?: string | null;
  /** Safe, user-facing fields to diff */
  fields: Record<string, unknown>;
};

export async function getAuditSnapshot(params: {
  resourceType: string;
  resourceId: string;
  organizationId?: string;
}): Promise<AuditSnapshot | null> {
  switch (params.resourceType) {
    case "team": {
      if (!params.organizationId) return null;
      const [row] = await db
        .select({
          id: schema.teamsTable.id,
          organizationId: schema.teamsTable.organizationId,
          name: schema.teamsTable.name,
          description: schema.teamsTable.description,
        })
        .from(schema.teamsTable)
        .where(eq(schema.teamsTable.id, params.resourceId))
        .limit(1);

      if (!row || row.organizationId !== params.organizationId) return null;
      return {
        name: row.name,
        fields: { name: row.name, description: row.description },
      };
    }

    case "agent": {
      if (!params.organizationId) return null;
      const [row] = await db
        .select({
          id: schema.agentsTable.id,
          organizationId: schema.agentsTable.organizationId,
          name: schema.agentsTable.name,
          scope: schema.agentsTable.scope,
          agentType: schema.agentsTable.agentType,
        })
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, params.resourceId))
        .limit(1);

      if (!row || row.organizationId !== params.organizationId) return null;
      return {
        name: row.name,
        fields: { name: row.name, scope: row.scope, agentType: row.agentType },
      };
    }

    case "mcpServer": {
      const [row] = await db
        .select({
          id: schema.mcpServersTable.id,
          name: schema.mcpServersTable.name,
          scope: schema.mcpServersTable.scope,
          teamId: schema.mcpServersTable.teamId,
          serverType: schema.mcpServersTable.serverType,
          catalogId: schema.mcpServersTable.catalogId,
        })
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, params.resourceId))
        .limit(1);

      if (!row) return null;
      return {
        name: row.name,
        fields: {
          name: row.name,
          scope: row.scope,
          teamId: row.teamId,
          serverType: row.serverType,
          catalogId: row.catalogId,
        },
      };
    }

    default:
      return null;
  }
}

export function diffAuditSnapshots(params: {
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
}) {
  const beforeFields = params.before?.fields ?? {};
  const afterFields = params.after?.fields ?? {};
  const keys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);

  const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const key of keys) {
    const from = beforeFields[key];
    const to = afterFields[key];
    if (from !== to) {
      changes.push({ field: key, from, to });
    }
  }
  return changes;
}

