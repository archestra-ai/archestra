import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertRuntimeCredentialDefinition,
  RuntimeCredentialDefinition,
  UpdateRuntimeCredentialDefinition,
} from "@/types";
import CreatedByModel from "./created-by";

export default class RuntimeCredentialDefinitionModel {
  static async hasGitHubUserDefinitions(params: {
    organizationId: string;
    key: string;
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.runtimeCredentialDefinitionsTable.id })
      .from(schema.runtimeCredentialDefinitionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(
            schema.runtimeCredentialDefinitionsTable.githubAppCredentialKey,
            params.key,
          ),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
  static async findById(params: { id: string; organizationId: string }) {
    const [definition] = await db
      .select()
      .from(schema.runtimeCredentialDefinitionsTable)
      .where(
        and(
          eq(schema.runtimeCredentialDefinitionsTable.id, params.id),
          eq(
            schema.runtimeCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);
    return definition ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [definition] = await db
      .select()
      .from(schema.runtimeCredentialDefinitionsTable)
      .where(
        and(
          eq(schema.runtimeCredentialDefinitionsTable.id, id),
          eq(
            schema.runtimeCredentialDefinitionsTable.organizationId,
            organizationId,
          ),
        ),
      )
      .limit(1);
    return toAuditSnapshot(definition ?? null);
  }

  static async findByKeyForAudit(
    key: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const definition = await RuntimeCredentialDefinitionModel.find({
      organizationId,
      key,
    });
    return toAuditSnapshot(definition);
  }

  static async create(params: {
    organizationId: string;
    createdBy: string;
    definition: InsertRuntimeCredentialDefinition;
  }): Promise<RuntimeCredentialDefinition> {
    const [created] = await db
      .insert(schema.runtimeCredentialDefinitionsTable)
      .values(
        await CreatedByModel.forInsert({
          data: {
            ...params.definition,
            organizationId: params.organizationId,
            createdBy: params.createdBy,
          },
          userIdField: "createdBy",
        }),
      )
      .returning();
    return created;
  }

  static async list(
    organizationId: string,
  ): Promise<RuntimeCredentialDefinition[]> {
    return db
      .select()
      .from(schema.runtimeCredentialDefinitionsTable)
      .where(
        eq(
          schema.runtimeCredentialDefinitionsTable.organizationId,
          organizationId,
        ),
      )
      .orderBy(asc(schema.runtimeCredentialDefinitionsTable.name));
  }

  static async find(params: {
    organizationId: string;
    key: string;
  }): Promise<RuntimeCredentialDefinition | null> {
    const [definition] = await db
      .select()
      .from(schema.runtimeCredentialDefinitionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.runtimeCredentialDefinitionsTable.key, params.key),
        ),
      )
      .limit(1);
    return definition ?? null;
  }

  static async update(params: {
    organizationId: string;
    key: string;
    definition: UpdateRuntimeCredentialDefinition;
  }): Promise<RuntimeCredentialDefinition | null> {
    const [updated] = await db
      .update(schema.runtimeCredentialDefinitionsTable)
      .set({ ...params.definition, updatedAt: new Date() })
      .where(
        and(
          eq(
            schema.runtimeCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.runtimeCredentialDefinitionsTable.key, params.key),
        ),
      )
      .returning();
    return updated ?? null;
  }

  static async delete(params: {
    organizationId: string;
    key: string;
  }): Promise<RuntimeCredentialDefinition | null> {
    const [deleted] = await db
      .delete(schema.runtimeCredentialDefinitionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.runtimeCredentialDefinitionsTable.key, params.key),
        ),
      )
      .returning();
    return deleted ?? null;
  }

  static async listOtherUsage(params: { organizationId: string; key: string }) {
    const definition = await RuntimeCredentialDefinitionModel.find(params);
    if (!definition) return [];
    const [catalogs, skills, plugins, connectors] = await Promise.all([
      db
        .select({
          id: schema.internalMcpCatalogTable.id,
          name: schema.internalMcpCatalogTable.name,
        })
        .from(schema.internalMcpCatalogTable)
        .where(
          and(
            eq(
              schema.internalMcpCatalogTable.organizationId,
              params.organizationId,
            ),
            isNull(schema.internalMcpCatalogTable.deletedAt),
            sql`${schema.internalMcpCatalogTable.localConfig}->'environment' @> ${JSON.stringify([{ credentialId: params.key }])}::jsonb`,
          ),
        ),
      db
        .select({ id: schema.skillsTable.id, name: schema.skillsTable.name })
        .from(schema.skillsTable)
        .where(
          and(
            eq(schema.skillsTable.organizationId, params.organizationId),
            isNull(schema.skillsTable.deletedAt),
            or(
              eq(schema.skillsTable.githubPatId, definition.id),
              eq(schema.skillsTable.githubAppConfigId, definition.id),
            ),
          ),
        ),
      db
        .select({
          id: schema.pluginsTable.id,
          name: schema.pluginsTable.displayName,
        })
        .from(schema.pluginsTable)
        .where(
          and(
            eq(schema.pluginsTable.organizationId, params.organizationId),
            or(
              eq(schema.pluginsTable.githubPatId, definition.id),
              eq(schema.pluginsTable.githubAppConfigId, definition.id),
            ),
          ),
        ),
      db
        .select({
          id: schema.knowledgeBaseConnectorsTable.id,
          name: schema.knowledgeBaseConnectorsTable.name,
        })
        .from(schema.knowledgeBaseConnectorsTable)
        .where(
          and(
            eq(
              schema.knowledgeBaseConnectorsTable.organizationId,
              params.organizationId,
            ),
            isNull(schema.knowledgeBaseConnectorsTable.deletedAt),
            sql`((${schema.knowledgeBaseConnectorsTable.config}->>'authMethod' = 'github_app' AND ${schema.knowledgeBaseConnectorsTable.config}->>'githubAppConfigId' = ${definition.id}) OR ${schema.knowledgeBaseConnectorsTable.config}->>'credentialId' = ${params.key})`,
          ),
        ),
    ]);
    return [
      ...catalogs.map((row) => ({ ...row, kind: "mcp" as const })),
      ...skills.map((row) => ({ ...row, kind: "skill" as const })),
      ...plugins.map((row) => ({ ...row, kind: "plugin" as const })),
      ...connectors.map((row) => ({ ...row, kind: "knowledge" as const })),
    ];
  }

  static async isUsedByAgent(params: {
    organizationId: string;
    key: string;
  }): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, params.organizationId),
          isNull(schema.agentsTable.deletedAt),
          sql`${schema.agentsTable.runtime}->'credentials' @> ${JSON.stringify([
            { credentialId: params.key },
          ])}::jsonb`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  static async listAgentsUsing(params: {
    organizationId: string;
    key: string;
  }): Promise<Array<{ id: string; name: string }>> {
    return db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.organizationId, params.organizationId),
          isNull(schema.agentsTable.deletedAt),
          sql`${schema.agentsTable.runtime}->'credentials' @> ${JSON.stringify([
            { credentialId: params.key },
          ])}::jsonb`,
        ),
      )
      .orderBy(asc(schema.agentsTable.name));
  }
}

// ===================== Internals =====================

function toAuditSnapshot(
  definition: RuntimeCredentialDefinition | null,
): Record<string, unknown> | null {
  if (!definition) return null;
  const { organizationId: _organizationId, ...snapshot } = definition;
  return snapshot;
}
