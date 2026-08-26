import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import secretsTable from "./secret";
import usersTable from "./user";

/**
 * A credential one user has deposited for their own use — the `per_user` half
 * of an agent's declared credentials (see `RunnerCredentialDeclaration`).
 *
 * Exists because some agents cannot act on a person's behalf with a shared
 * organization credential: a Claude Code subscription token, a personal GitHub
 * PAT, anything where the upstream identity must be the individual's. The
 * value never leaves the secrets manager; this row only carries the reference.
 *
 * Distinct from `github_pats`, which is organization-scoped and serves skill
 * import/sync — a personal GitHub token belongs here instead.
 */
const userCredentialsTable = pgTable(
  "user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /**
     * Declaration key this satisfies, and the environment variable name the
     * value is injected under (e.g. `CLAUDE_CODE_OAUTH_TOKEN`).
     */
    key: text("key").notNull(),
    /** Reference into the secrets manager; the value is never stored here. */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("user_credentials_user_id_idx").on(table.userId),
    uniqueIndex("user_credentials_org_user_key_uidx").on(
      table.organizationId,
      table.userId,
      table.key,
    ),
  ],
);

export default userCredentialsTable;
