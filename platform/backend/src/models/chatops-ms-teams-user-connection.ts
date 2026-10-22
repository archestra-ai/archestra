import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import {
  type ChatOpsMsTeamsUserConnection,
  type MsTeamsUserTokens,
  MsTeamsUserTokensSchema,
} from "@/types/chatops-ms-teams-user-connection";

/**
 * Teams users who signed in to the bot so it can read their group-chat files.
 * Tokens only ever live in the secrets manager; a row carries the reference.
 */
class ChatOpsMsTeamsUserConnectionModel {
  static async find(params: {
    tenantId: string;
    aadObjectId: string;
  }): Promise<ChatOpsMsTeamsUserConnection | null> {
    const table = schema.chatopsMsTeamsUserConnectionsTable;
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.tenantId, params.tenantId),
          eq(table.aadObjectId, params.aadObjectId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The connection's tokens, or null when its secret is gone or unreadable.
   * Read past the cache: another replica may have refreshed them.
   */
  static async getTokens(
    connection: ChatOpsMsTeamsUserConnection,
  ): Promise<MsTeamsUserTokens | null> {
    const secret = await secretManager().getSecret(connection.secretId, {
      skipCache: true,
    });
    const parsed = MsTeamsUserTokensSchema.safeParse(secret?.secret);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Store a fresh sign-in, replacing any earlier one for the same account. The
   * new secret is written before the old one is deleted, so a crash midway
   * leaves a working connection.
   */
  static async save(params: {
    tenantId: string;
    aadObjectId: string;
    scope: string;
    tokens: MsTeamsUserTokens;
  }): Promise<ChatOpsMsTeamsUserConnection> {
    const { tenantId, aadObjectId, scope, tokens } = params;
    const table = schema.chatopsMsTeamsUserConnectionsTable;
    const existing = await ChatOpsMsTeamsUserConnectionModel.find({
      tenantId,
      aadObjectId,
    });
    const secret = await secretManager().createSecret(
      tokens,
      `ms-teams-user-connection-${tenantId}-${aadObjectId}`,
    );
    const [row] = await db
      .insert(table)
      .values({ tenantId, aadObjectId, scope, secretId: secret.id })
      .onConflictDoUpdate({
        target: [table.tenantId, table.aadObjectId],
        set: { scope, secretId: secret.id, updatedAt: new Date() },
      })
      .returning();
    if (existing && existing.secretId !== secret.id) {
      await deleteSecretQuietly(existing.secretId);
    }
    return row;
  }

  /** Replace the tokens of an existing connection after a refresh. */
  static async updateTokens(params: {
    connection: ChatOpsMsTeamsUserConnection;
    tokens: MsTeamsUserTokens;
  }): Promise<void> {
    await secretManager().updateSecret(
      params.connection.secretId,
      params.tokens,
    );
  }

  static async delete(params: {
    tenantId: string;
    aadObjectId: string;
  }): Promise<boolean> {
    const table = schema.chatopsMsTeamsUserConnectionsTable;
    const [deleted] = await db
      .delete(table)
      .where(
        and(
          eq(table.tenantId, params.tenantId),
          eq(table.aadObjectId, params.aadObjectId),
        ),
      )
      .returning();
    if (!deleted) return false;
    await deleteSecretQuietly(deleted.secretId);
    return true;
  }
}

export default ChatOpsMsTeamsUserConnectionModel;

/**
 * A stale secret left behind is inert; a throw here would fail an otherwise
 * successful sign-in or sign-out, so the failure is logged and swallowed.
 */
async function deleteSecretQuietly(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    logger.warn(
      { error, secretId },
      "Failed to delete MS Teams user connection secret",
    );
  }
}
