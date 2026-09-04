import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RuntimeCredentialConnectionScope } from "@/types/runtime-credential-connection";
import secretsTable from "./secret";
import usersTable from "./user";

/**
 * A reusable secret connection for Agent Runtime containers.
 *
 * Agent definitions refer to `credentialId`; they never own or copy the
 * secret. A personal row follows the user across every Agent declaring that
 * identifier. An organization row does the same for shared credentials.
 */
const runtimeCredentialConnectionsTable = pgTable(
  "runtime_credential_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    scope: text("scope").$type<RuntimeCredentialConnectionScope>().notNull(),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    /** Stable semantic identifier, such as `github` or `acme-deploy`. */
    credentialId: text("credential_id").notNull(),
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
    check(
      "runtime_credential_connections_scope_check",
      sql`${table.scope} in ('personal', 'organization')`,
    ),
    check(
      "runtime_credential_connections_owner_check",
      sql`(${table.scope} = 'personal' and ${table.userId} is not null) or (${table.scope} = 'organization' and ${table.userId} is null)`,
    ),
    index("runtime_credential_connections_org_idx").on(table.organizationId),
    index("runtime_credential_connections_user_idx").on(table.userId),
    uniqueIndex("runtime_credential_connections_personal_uidx")
      .on(table.organizationId, table.userId, table.credentialId)
      .where(sql`${table.scope} = 'personal'`),
    uniqueIndex("runtime_credential_connections_organization_uidx")
      .on(table.organizationId, table.credentialId)
      .where(sql`${table.scope} = 'organization'`),
  ],
);

export default runtimeCredentialConnectionsTable;
