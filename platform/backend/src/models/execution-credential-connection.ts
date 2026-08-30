import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  ExecutionCredentialConnection,
  ExecutionCredentialConnectionScope,
} from "@/types";

export default class ExecutionCredentialConnectionModel {
  static async upsert(params: {
    organizationId: string;
    scope: ExecutionCredentialConnectionScope;
    userId: string | null;
    credentialId: string;
    value: string;
  }): Promise<ExecutionCredentialConnection> {
    const existing = await ExecutionCredentialConnectionModel.find(params);
    const secret = await secretManager().createSecret(
      { [SECRET_VALUE_FIELD]: params.value },
      `execution-credential-${params.scope}-${params.credentialId}`,
    );

    try {
      if (existing) {
        const [updated] = await db
          .update(schema.executionCredentialConnectionsTable)
          .set({
            secretId: secret.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.executionCredentialConnectionsTable.id, existing.id))
          .returning();
        await deleteSecretQuietly(existing.secretId);
        return updated;
      }

      const [created] = await db
        .insert(schema.executionCredentialConnectionsTable)
        .values({
          organizationId: params.organizationId,
          scope: params.scope,
          userId: params.scope === "personal" ? params.userId : null,
          credentialId: params.credentialId,
          secretId: secret.id,
        })
        .returning();
      return created;
    } catch (error) {
      await deleteSecretQuietly(secret.id);
      throw error;
    }
  }

  static async resolveValue(params: {
    organizationId: string;
    scope: ExecutionCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<string | null> {
    const connection = await ExecutionCredentialConnectionModel.find(params);
    if (!connection) return null;
    const secret = await secretManager().getSecret(connection.secretId);
    const value = secret?.secret?.[SECRET_VALUE_FIELD];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  static async delete(params: {
    organizationId: string;
    scope: ExecutionCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<boolean> {
    const existing = await ExecutionCredentialConnectionModel.find(params);
    if (!existing) return false;
    await db
      .delete(schema.executionCredentialConnectionsTable)
      .where(eq(schema.executionCredentialConnectionsTable.id, existing.id));
    await deleteSecretQuietly(existing.secretId);
    return true;
  }

  static async listConfigured(params: {
    organizationId: string;
    userId: string;
  }): Promise<
    Array<{
      credentialId: string;
      scope: ExecutionCredentialConnectionScope;
    }>
  > {
    return db
      .select({
        credentialId: schema.executionCredentialConnectionsTable.credentialId,
        scope: schema.executionCredentialConnectionsTable.scope,
      })
      .from(schema.executionCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.executionCredentialConnectionsTable.organizationId,
            params.organizationId,
          ),
          sql`${schema.executionCredentialConnectionsTable.scope} = 'organization' OR ${schema.executionCredentialConnectionsTable.userId} = ${params.userId}`,
        ),
      );
  }

  static async findForAudit(params: {
    organizationId: string;
    scope: ExecutionCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<Record<string, unknown> | null> {
    const connection = await ExecutionCredentialConnectionModel.find(params);
    if (!connection) return null;
    return {
      id: connection.id,
      credentialId: connection.credentialId,
      scope: connection.scope,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  static async deleteForDefinition(params: {
    organizationId: string;
    credentialId: string;
  }): Promise<void> {
    const deleted = await db
      .delete(schema.executionCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.executionCredentialConnectionsTable.organizationId,
            params.organizationId,
          ),
          eq(
            schema.executionCredentialConnectionsTable.credentialId,
            params.credentialId,
          ),
        ),
      )
      .returning({
        secretId: schema.executionCredentialConnectionsTable.secretId,
      });
    await Promise.all(
      deleted.map(({ secretId }) => deleteSecretQuietly(secretId)),
    );
  }

  private static async find(params: {
    organizationId: string;
    scope: ExecutionCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<ExecutionCredentialConnection | null> {
    const [row] = await db
      .select()
      .from(schema.executionCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.executionCredentialConnectionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.executionCredentialConnectionsTable.scope, params.scope),
          params.scope === "personal"
            ? eq(
                schema.executionCredentialConnectionsTable.userId,
                params.userId ?? "",
              )
            : isNull(schema.executionCredentialConnectionsTable.userId),
          eq(
            schema.executionCredentialConnectionsTable.credentialId,
            params.credentialId,
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

// ===================== Internals =====================

const SECRET_VALUE_FIELD = "value";

async function deleteSecretQuietly(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    logger.warn(
      { error, secretId },
      "Failed to delete replaced execution credential secret",
    );
  }
}
