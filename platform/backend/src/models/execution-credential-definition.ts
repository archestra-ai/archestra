import { and, asc, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ExecutionCredentialDefinition,
  InsertExecutionCredentialDefinition,
  UpdateExecutionCredentialDefinition,
} from "@/types";

export default class ExecutionCredentialDefinitionModel {
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [definition] = await db
      .select()
      .from(schema.executionCredentialDefinitionsTable)
      .where(
        and(
          eq(schema.executionCredentialDefinitionsTable.id, id),
          eq(
            schema.executionCredentialDefinitionsTable.organizationId,
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
    const definition = await ExecutionCredentialDefinitionModel.find({
      organizationId,
      key,
    });
    return toAuditSnapshot(definition);
  }

  static async create(params: {
    organizationId: string;
    createdBy: string;
    definition: InsertExecutionCredentialDefinition;
  }): Promise<ExecutionCredentialDefinition> {
    const [created] = await db
      .insert(schema.executionCredentialDefinitionsTable)
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
  ): Promise<ExecutionCredentialDefinition[]> {
    return db
      .select()
      .from(schema.executionCredentialDefinitionsTable)
      .where(
        eq(
          schema.executionCredentialDefinitionsTable.organizationId,
          organizationId,
        ),
      )
      .orderBy(asc(schema.executionCredentialDefinitionsTable.name));
  }

  static async find(params: {
    organizationId: string;
    key: string;
  }): Promise<ExecutionCredentialDefinition | null> {
    const [definition] = await db
      .select()
      .from(schema.executionCredentialDefinitionsTable)
      .where(
        and(
          eq(
            schema.executionCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.executionCredentialDefinitionsTable.key, params.key),
        ),
      )
      .limit(1);
    return definition ?? null;
  }

  static async update(params: {
    organizationId: string;
    key: string;
    definition: UpdateExecutionCredentialDefinition;
  }): Promise<ExecutionCredentialDefinition | null> {
    const [updated] = await db
      .update(schema.executionCredentialDefinitionsTable)
      .set({ ...params.definition, updatedAt: new Date() })
      .where(
        and(
          eq(
            schema.executionCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.executionCredentialDefinitionsTable.key, params.key),
        ),
      )
      .returning();
    return updated ?? null;
  }

  static async delete(params: {
    organizationId: string;
    key: string;
  }): Promise<ExecutionCredentialDefinition | null> {
    const [deleted] = await db
      .delete(schema.executionCredentialDefinitionsTable)
      .where(
        and(
          eq(
            schema.executionCredentialDefinitionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.executionCredentialDefinitionsTable.key, params.key),
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
          sql`${schema.agentsTable.backgroundExecution}->'credentials' @> ${JSON.stringify(
            [{ credentialId: params.key }],
          )}::jsonb`,
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
          sql`${schema.agentsTable.backgroundExecution}->'credentials' @> ${JSON.stringify(
            [{ credentialId: params.key }],
          )}::jsonb`,
        ),
      )
      .orderBy(asc(schema.agentsTable.name));
  }
}

// ===================== Internals =====================

function toAuditSnapshot(
  definition: ExecutionCredentialDefinition | null,
): Record<string, unknown> | null {
  if (!definition) return null;
  const { organizationId: _organizationId, ...snapshot } = definition;
  return snapshot;
}
