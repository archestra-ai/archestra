import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  GitHubUserId,
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
    /** Omitted on refresh so the account bound at sign-in is kept. */
    githubId?: GitHubUserId;
  }): Promise<RuntimeCredentialConnection> {
    const existing = await RuntimeCredentialConnectionModel.find(params);
    const secret = await secretManager().createSecret(
      { [SECRET_VALUE_FIELD]: params.value },
      `credential-${params.scope}-${params.credentialId}`,
    );

    try {
      if (existing) {
        const [updated] = await db
          .update(schema.runtimeCredentialConnectionsTable)
          .set({
            secretId: secret.id,
            secretKey: SECRET_VALUE_FIELD,
            ...(params.githubId !== undefined && { githubId: params.githubId }),
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
          githubId: params.githubId,
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
    const secret = await secretManager().getSecret(connection.secretId, {
      skipCache: true,
    });
    const value = secret?.secret?.[connection.secretKey];
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

  /** Credential ids holding an organization-level value. */
  static async listOrganizationCredentialIds(
    organizationId: string,
  ): Promise<string[]> {
    const rows = await db
      .select({
        credentialId: schema.runtimeCredentialConnectionsTable.credentialId,
      })
      .from(schema.runtimeCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialConnectionsTable.organizationId,
            organizationId,
          ),
          eq(schema.runtimeCredentialConnectionsTable.scope, "organization"),
        ),
      );
    return rows.map((row) => row.credentialId);
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
          sql`(${schema.runtimeCredentialConnectionsTable.scope} = 'organization' OR ${schema.runtimeCredentialConnectionsTable.userId} = ${params.userId})`,
        ),
      );
  }

  /**
   * GitHub account id to email of current organization members connected
   * through a GitHub.com App. Ids held by more than one user are dropped.
   */
  static async listGitHubRoster(
    organizationId: string,
  ): Promise<Map<GitHubUserId, string>> {
    const connections = schema.runtimeCredentialConnectionsTable;
    const userCredential = alias(
      schema.runtimeCredentialDefinitionsTable,
      "user_credential",
    );
    const githubApp = alias(
      schema.runtimeCredentialDefinitionsTable,
      "github_app",
    );
    const rows = await db
      .selectDistinct({
        githubId: connections.githubId,
        userId: schema.usersTable.id,
        email: schema.usersTable.email,
      })
      .from(connections)
      .innerJoin(
        userCredential,
        and(
          eq(userCredential.organizationId, connections.organizationId),
          eq(userCredential.key, connections.credentialId),
          eq(userCredential.kind, "github_app_user"),
        ),
      )
      .innerJoin(
        githubApp,
        and(
          eq(githubApp.organizationId, connections.organizationId),
          eq(githubApp.key, userCredential.githubAppCredentialKey),
          eq(githubApp.githubUrl, GITHUB_COM_API_URL),
        ),
      )
      .innerJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.organizationId, connections.organizationId),
          eq(schema.membersTable.userId, connections.userId),
        ),
      )
      .innerJoin(
        schema.usersTable,
        eq(schema.usersTable.id, connections.userId),
      )
      .where(
        and(
          eq(connections.organizationId, organizationId),
          eq(connections.scope, "personal"),
          isNotNull(connections.githubId),
        ),
      );

    const holders = new Map<GitHubUserId, Map<string, string>>();
    for (const { githubId, userId, email } of rows) {
      if (githubId === null) continue;
      const users = holders.get(githubId) ?? new Map<string, string>();
      users.set(userId, email);
      holders.set(githubId, users);
    }
    const roster = new Map<GitHubUserId, string>();
    for (const [githubId, users] of holders) {
      const [only, ...rest] = users.values();
      if (rest.length === 0) roster.set(githubId, only);
    }
    return roster;
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
const GITHUB_COM_API_URL = "https://api.github.com";

async function deleteSecretQuietly(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    logger.warn(
      { error, secretId },
      "Failed to delete replaced credential secret",
    );
  }
}
