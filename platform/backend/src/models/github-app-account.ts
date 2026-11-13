import { schema, type Transaction } from "@/database";
import type { InsertGithubAppAccount } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * The GitHub accounts provider keys reach through a GitHub App: the
 * organization a GitHub Copilot plan bills. Written with the key, in the same
 * transaction, so a GitHub account that already has a key refuses the second.
 */
class GithubAppAccountModel {
  /** Record a new key's GitHub account, in the transaction creating the key. */
  static async create(params: {
    data: InsertGithubAppAccount;
    transaction: Transaction;
  }): Promise<void> {
    await params.transaction
      .insert(schema.githubAppAccountsTable)
      .values(params.data);
  }

  /** Whether a write failed because another key has the GitHub account. */
  static isTaken(error: unknown): boolean {
    return isUniqueConstraintError(error, "github_app_accounts_account_unique");
  }
}

export default GithubAppAccountModel;
