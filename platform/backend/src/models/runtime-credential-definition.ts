import { and, asc, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertRuntimeCredentialDefinition,
  RuntimeCredentialDefinition,
  UpdateRuntimeCredentialDefinition,
} from "@/types";

export default class RuntimeCredentialDefinitionModel {
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
      .values({
        ...params.definition,
        organizationId: params.organizationId,
        createdBy: params.createdBy,
      })
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
