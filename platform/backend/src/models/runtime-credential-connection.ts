import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  RuntimeCredentialConnection,
  RuntimeCredentialConnectionScope,
} from "@/types";

export default class RuntimeCredentialConnectionModel {
  static async upsert(params: {
    organizationId: string;
    scope: RuntimeCredentialConnectionScope;
    userId: string | null;
    credentialId: string;
    value: string;
  }): Promise<RuntimeCredentialConnection> {
    const existing = await RuntimeCredentialConnectionModel.find(params);
    const secret = await secretManager().createSecret(
      { [SECRET_VALUE_FIELD]: params.value },
      `runtime-credential-${params.scope}-${params.credentialId}`,
    );

    try {
      if (existing) {
        const [updated] = await db
          .update(schema.runtimeCredentialConnectionsTable)
          .set({
            secretId: secret.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.runtimeCredentialConnectionsTable.id, existing.id))
          .returning();
        await deleteSecretQuietly(existing.secretId);
        return updated;
      }

      const [created] = await db
        .insert(schema.runtimeCredentialConnectionsTable)
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
    scope: RuntimeCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<string | null> {
    const connection = await RuntimeCredentialConnectionModel.find(params);
    if (!connection) return null;
    const secret = await secretManager().getSecret(connection.secretId);
    const value = secret?.secret?.[SECRET_VALUE_FIELD];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  static async delete(params: {
    organizationId: string;
    scope: RuntimeCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<boolean> {
    const existing = await RuntimeCredentialConnectionModel.find(params);
    if (!existing) return false;
    await db
      .delete(schema.runtimeCredentialConnectionsTable)
      .where(eq(schema.runtimeCredentialConnectionsTable.id, existing.id));
    await deleteSecretQuietly(existing.secretId);
    return true;
  }

  static async listConfigured(params: {
    organizationId: string;
    userId: string;
  }): Promise<
    Array<{
      credentialId: string;
      scope: RuntimeCredentialConnectionScope;
    }>
  > {
    return db
      .select({
        credentialId: schema.runtimeCredentialConnectionsTable.credentialId,
        scope: schema.runtimeCredentialConnectionsTable.scope,
      })
      .from(schema.runtimeCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialConnectionsTable.organizationId,
            params.organizationId,
          ),
          sql`${schema.runtimeCredentialConnectionsTable.scope} = 'organization' OR ${schema.runtimeCredentialConnectionsTable.userId} = ${params.userId}`,
        ),
      );
  }

  static async findForAudit(params: {
    organizationId: string;
    scope: RuntimeCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<Record<string, unknown> | null> {
    const connection = await RuntimeCredentialConnectionModel.find(params);
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
      .delete(schema.runtimeCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialConnectionsTable.organizationId,
            params.organizationId,
          ),
          eq(
            schema.runtimeCredentialConnectionsTable.credentialId,
            params.credentialId,
          ),
        ),
      )
      .returning({
        secretId: schema.runtimeCredentialConnectionsTable.secretId,
      });
    await Promise.all(
      deleted.map(({ secretId }) => deleteSecretQuietly(secretId)),
    );
  }

  private static async find(params: {
    organizationId: string;
    scope: RuntimeCredentialConnectionScope;
    userId?: string | null;
    credentialId: string;
  }): Promise<RuntimeCredentialConnection | null> {
    const [row] = await db
      .select()
      .from(schema.runtimeCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialConnectionsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.runtimeCredentialConnectionsTable.scope, params.scope),
          params.scope === "personal"
            ? eq(
                schema.runtimeCredentialConnectionsTable.userId,
                params.userId ?? "",
              )
            : isNull(schema.runtimeCredentialConnectionsTable.userId),
          eq(
            schema.runtimeCredentialConnectionsTable.credentialId,
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
      "Failed to delete replaced runtime credential secret",
    );
  }
}
