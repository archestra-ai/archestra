import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import secretsTable from "./secret";
import usersTable from "./user";

/**
 * A credential one user has deposited for one Agent deployment — the `per_user` half of
 * its declared Background execution credentials.
 *
 * Exists because some deployments cannot act on a person's behalf with a shared
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
    /** Agent whose background-execution declaration this credential satisfies. */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
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
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("user_credentials_user_id_idx").on(table.userId),
    index("user_credentials_agent_id_idx").on(table.agentId),
    uniqueIndex("user_credentials_org_user_agent_key_uidx").on(
      table.organizationId,
      table.userId,
      table.agentId,
      table.key,
    ),
  ],
);

export default userCredentialsTable;
