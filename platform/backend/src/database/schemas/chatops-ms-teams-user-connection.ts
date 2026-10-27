import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import secretsTable from "./secret";

/**
 * A Microsoft Teams user who signed in to the bot so it can read the files they
 * share in group chats. Teams stores those files in the sender's own OneDrive,
 * which no app-level grant reaches, so the bot reads them with the sender's
 * delegated token instead. Keyed by the Microsoft identity, not an Archestra
 * user: the token belongs to that Entra account.
 */
const chatopsMsTeamsUserConnectionsTable = pgTable(
  "chatops_ms_teams_user_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Entra tenant the account belongs to. */
    tenantId: text("tenant_id").notNull(),
    /** Entra object id of the account (Teams `from.aadObjectId`). */
    aadObjectId: text("aad_object_id").notNull(),
    /** Reference into the secrets manager; tokens are never stored here. */
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secretsTable.id, { onDelete: "cascade" }),
    /** Delegated scopes Microsoft granted, space-separated. */
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("chatops_ms_teams_user_connections_tenant_user_uidx").on(
      table.tenantId,
      table.aadObjectId,
    ),
  ],
);

export default chatopsMsTeamsUserConnectionsTable;
