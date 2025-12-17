import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
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
   * Delete all accounts with a specific providerId.
   * This is used to clean up SSO accounts when an SSO provider is deleted,
   * preventing orphaned accounts that could cause issues with future SSO logins.
   *
   * @returns The number of accounts deleted
   */
  static async deleteByProviderId(providerId: string): Promise<number> {
    logger.debug(
      { providerId },
      "AccountModel.deleteByProviderId: deleting accounts",
    );
    const deleted = await db
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
