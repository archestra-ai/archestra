import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import llmProviderApiKeysTable from "./llm-provider-api-key";

/**
 * The GitHub account a provider key reaches through a GitHub App: today, the
 * GitHub organization a GitHub Copilot plan bills. It is written in the
 * transaction that creates the key, so its unique constraints keep one plan
 * per GitHub organization even when two connects race; deleting the key frees
 * the account. Keys without a GitHub App have no row, and neither do plans
 * connected before this table existed (their account is only inside the
 * encrypted key value).
 */
const githubAppAccountsTable = pgTable(
  "github_app_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    providerApiKeyId: uuid("provider_api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    /** The GitHub's web address, in lower case: `https://github.com`. */
    githubUrl: text("github_url").notNull(),
    /** The account's login on that GitHub, in lower case. */
    login: text("login").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // One key per GitHub account in an organization.
    unique("github_app_accounts_account_unique").on(
      table.organizationId,
      table.githubUrl,
      table.login,
    ),
    // One GitHub account per key.
    unique("github_app_accounts_provider_api_key_unique").on(
      table.providerApiKeyId,
    ),
  ],
);

export default githubAppAccountsTable;
