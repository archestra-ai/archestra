import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import { team } from "./team";
import usersTable from "./user";

const serviceAccountsTable = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    /**
     * Team the account acts for. Grants made to the team (and its ancestors)
     * reach the account, and MCP credentials resolved at call time prefer the
     * team's installs. Null for an account that acts for the organization.
     */
    teamId: text("team_id").references((): AnyPgColumn => team.id, {
      onDelete: "set null",
    }),
    /**
     * The organization's built-in account for headless work that has no user
     * behind it (scheduled triggers, incoming email, delegated runs). Created
     * on demand, one per organization, and never listed or editable.
     */
    isSystem: boolean("is_system").notNull().default(false),
    /**
     * Who created this. Nullable: rows predating creator tracking have no
     * answer, and `ON DELETE SET NULL` gives the column back to "unknown" when
     * the account is deleted rather than taking the account with it — the
     * organization owns service accounts, not the person who happened to make it.
     */
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Service account creator; separate from human ownership. */
    createdByServiceAccountId: uuid("created_by_service_account_id").references(
      (): AnyPgColumn => serviceAccountsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [
    index("service_accounts_organization_id_idx").on(table.organizationId),
    index("service_accounts_team_id_idx").on(table.teamId),
    uniqueIndex("service_accounts_organization_id_name_unique_idx").on(
      table.organizationId,
      table.name,
    ),
    uniqueIndex("service_accounts_organization_id_system_unique_idx")
      .on(table.organizationId)
      .where(sql`${table.isSystem}`),
  ],
);

export default serviceAccountsTable;
