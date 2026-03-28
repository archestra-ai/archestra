import { and, desc, eq, isNotNull } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";

class AccountModel {
  /**
   * Get the first account for a user by userId
   */
  static async getByUserId(userId: string) {
    logger.debug({ userId }, "AccountModel.getByUserId: fetching account");
    const [account] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, userId))
      .limit(1);
    logger.debug(
      { userId, found: !!account },
      "AccountModel.getByUserId: completed",
    );
    return account;
  }

  /**
   * Get all accounts for a user ordered by updatedAt DESC (most recent first)
   * Used to find the most recently used SSO account for team sync
   */
  static async getAllByUserId(userId: string) {
    logger.debug(
      { userId },
      "AccountModel.getAllByUserId: fetching all accounts",
    );
    const accounts = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, userId))
      .orderBy(desc(schema.accountsTable.updatedAt));
    logger.debug(
      { userId, count: accounts.length },
      "AccountModel.getAllByUserId: completed",
    );
    return accounts;
  }

  /**
   * Get the most recently updated SSO account for a user and provider.
   * Used when session-authenticated requests need to recover the original
   * enterprise IdP JWT for downstream propagation.
   */
  static async getLatestSsoAccountByUserIdAndProviderId(
    userId: string,
    providerId: string,
  ) {
    logger.debug(
      { userId, providerId },
      "AccountModel.getLatestSsoAccountByUserIdAndProviderId: fetching account",
    );
    const [account] = await db
      .select()
      .from(schema.accountsTable)
      .where(
        and(
          eq(schema.accountsTable.userId, userId),
          eq(schema.accountsTable.providerId, providerId),
        ),
      )
      .orderBy(desc(schema.accountsTable.updatedAt))
      .limit(1);
    logger.debug(
      { userId, providerId, found: !!account },
      "AccountModel.getLatestSsoAccountByUserIdAndProviderId: completed",
    );
    return account;
  }

  /**
   * Get the most recently updated linked identity account for a user that has
   * a stored access token. Used for install-time MCP tool discovery when the
   * user explicitly opts into reusing their current identity-provider token.
   */
  static async getLatestSsoAccountWithAccessTokenByUserId(userId: string) {
    logger.debug(
      { userId },
      "AccountModel.getLatestSsoAccountWithAccessTokenByUserId: fetching account",
    );
    const [account] = await db
      .select()
      .from(schema.accountsTable)
      .where(
        and(
          eq(schema.accountsTable.userId, userId),
          isNotNull(schema.accountsTable.accessToken),
        ),
      )
      .orderBy(desc(schema.accountsTable.updatedAt))
      .limit(1);
    logger.debug(
      { userId, found: !!account },
      "AccountModel.getLatestSsoAccountWithAccessTokenByUserId: completed",
    );
    return account;
  }

  static async updateTokens(params: {
    id: string;
    accessToken: string;
    refreshToken?: string | null;
    idToken?: string | null;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
  }) {
    logger.debug(
      { accountId: params.id },
      "AccountModel.updateTokens: updating account tokens",
    );
    const [account] = await db
      .update(schema.accountsTable)
      .set({
        accessToken: params.accessToken,
        ...(params.refreshToken !== undefined && {
          refreshToken: params.refreshToken,
        }),
        ...(params.idToken !== undefined && { idToken: params.idToken }),
        ...(params.accessTokenExpiresAt !== undefined && {
          accessTokenExpiresAt: params.accessTokenExpiresAt,
        }),
        ...(params.refreshTokenExpiresAt !== undefined && {
          refreshTokenExpiresAt: params.refreshTokenExpiresAt,
        }),
        updatedAt: new Date(),
      })
      .where(eq(schema.accountsTable.id, params.id))
      .returning();
    logger.debug(
      { accountId: params.id, updated: !!account },
      "AccountModel.updateTokens: completed",
    );
    return account ?? null;
  }

  /**
   * Delete all accounts with a specific providerId.
   * This is used to clean up SSO accounts when an SSO provider is deleted,
   * preventing orphaned accounts that could cause issues with future SSO logins.
   *
   * @param providerId - The provider ID to delete accounts for
   * @param tx - Optional transaction to use for deletion
   * @returns The number of accounts deleted
   */
  static async deleteByProviderId(
    providerId: string,
    tx?: Transaction,
  ): Promise<number> {
    logger.debug(
      { providerId },
      "AccountModel.deleteByProviderId: deleting accounts",
    );
    const dbOrTx = tx || db;
    const deleted = await dbOrTx
      .delete(schema.accountsTable)
      .where(eq(schema.accountsTable.providerId, providerId))
      .returning({ id: schema.accountsTable.id });
    logger.debug(
      { providerId, count: deleted.length },
      "AccountModel.deleteByProviderId: completed",
    );
    return deleted.length;
  }
}

export default AccountModel;
