import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { CREDENTIAL_PROVIDER_ID } from "@/constants";
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
  static async getAllByUserId(userId: string, tx?: Transaction) {
    logger.debug(
      { userId },
      "AccountModel.getAllByUserId: fetching all accounts",
    );
    const dbOrTx = tx ?? db;
    const accounts = await dbOrTx
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
    tx?: Transaction,
  ) {
    logger.debug(
      { userId, providerId },
      "AccountModel.getLatestSsoAccountByUserIdAndProviderId: fetching account",
    );
    const dbOrTx = tx ?? db;
    const [account] = await dbOrTx
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
   * Get a user's email/password account, if they have one (SSO-only users
   * don't).
   */
  static async getCredentialAccountByUserId(userId: string, tx?: Transaction) {
    logger.debug(
      { userId },
      "AccountModel.getCredentialAccountByUserId: fetching account",
    );
    const dbOrTx = tx ?? db;
    const [account] = await dbOrTx
      .select()
      .from(schema.accountsTable)
      .where(
        and(
          eq(schema.accountsTable.userId, userId),
          eq(schema.accountsTable.providerId, CREDENTIAL_PROVIDER_ID),
        ),
      )
      .limit(1);
    logger.debug(
      { userId, found: !!account },
      "AccountModel.getCredentialAccountByUserId: completed",
    );
    return account;
  }

  /**
   * Create an email/password account for a user who doesn't have one yet
   * (e.g. an SSO-provisioned user). Mirrors Better Auth's credential-account
   * shape: providerId "credential" and accountId equal to the user id.
   *
   * `passwordHash` must be a Better Auth scrypt hash (`hashPassword` from
   * "better-auth/crypto"), never a plaintext password.
   */
  static async createCredentialAccount(params: {
    userId: string;
    passwordHash: string;
    tx?: Transaction;
  }) {
    logger.debug(
      { userId: params.userId },
      "AccountModel.createCredentialAccount: creating account",
    );
    const dbOrTx = params.tx ?? db;
    const [account] = await dbOrTx
      .insert(schema.accountsTable)
      .values({
        id: crypto.randomUUID(),
        accountId: params.userId,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: params.userId,
        password: params.passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    logger.debug(
      { userId: params.userId, accountId: account?.id },
      "AccountModel.createCredentialAccount: completed",
    );
    return account;
  }

  /**
   * Replace the stored password hash of an account.
   *
   * `passwordHash` must be a Better Auth scrypt hash (`hashPassword` from
   * "better-auth/crypto"), never a plaintext password.
   */
  static async setPassword(params: {
    id: string;
    passwordHash: string;
    tx?: Transaction;
  }) {
    logger.debug(
      { accountId: params.id },
      "AccountModel.setPassword: updating password",
    );
    const dbOrTx = params.tx ?? db;
    const [account] = await dbOrTx
      .update(schema.accountsTable)
      .set({
        password: params.passwordHash,
        updatedAt: new Date(),
      })
      .where(eq(schema.accountsTable.id, params.id))
      .returning();
    logger.debug(
      { accountId: params.id, updated: !!account },
      "AccountModel.setPassword: completed",
    );
    return account ?? null;
  }

  static async moveToUser(params: {
    id: string;
    userId: string;
    tx?: Transaction;
  }) {
    logger.debug(
      { accountId: params.id, userId: params.userId },
      "AccountModel.moveToUser: moving account",
    );
    const dbOrTx = params.tx ?? db;
    const [account] = await dbOrTx
      .update(schema.accountsTable)
      .set({
        userId: params.userId,
        updatedAt: new Date(),
      })
      .where(eq(schema.accountsTable.id, params.id))
      .returning();
    logger.debug(
      { accountId: params.id, moved: !!account },
      "AccountModel.moveToUser: completed",
    );
    return account ?? null;
  }

  static async countByUserId(userId: string, tx?: Transaction) {
    logger.debug({ userId }, "AccountModel.countByUserId: counting accounts");
    const dbOrTx = tx ?? db;
    const [result] = await dbOrTx
      .select({ count: count() })
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, userId));
    const accountCount = result?.count ?? 0;
    logger.debug(
      { userId, count: accountCount },
      "AccountModel.countByUserId: completed",
    );
    return accountCount;
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

  static async deleteByUserIdAndProviderId(params: {
    userId: string;
    providerId: string;
    tx?: Transaction;
  }) {
    const logContext = {
      userId: params.userId,
      providerId: params.providerId,
    };
    logger.debug(
      logContext,
      "AccountModel.deleteByUserIdAndProviderId: deleting account",
    );
    const dbOrTx = params.tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.accountsTable)
      .where(
        and(
          eq(schema.accountsTable.userId, params.userId),
          eq(schema.accountsTable.providerId, params.providerId),
        ),
      )
      .returning({ id: schema.accountsTable.id });
    logger.debug(
      { ...logContext, count: deleted.length },
      "AccountModel.deleteByUserIdAndProviderId: completed",
    );
    return deleted.length;
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
    const dbOrTx = tx ?? db;
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
