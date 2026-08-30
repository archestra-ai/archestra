import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import usersTable from "./user";

/** Organization-defined credential types available to Agent image bindings. */
const executionCredentialDefinitionsTable = pgTable(
  "execution_credential_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    icon: text("icon"),
    allowPersonal: boolean("allow_personal").notNull().default(true),
    allowOrganization: boolean("allow_organization").notNull().default(false),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "execution_credential_definitions_scope_check",
      sql`(${table.allowPersonal} and not ${table.allowOrganization}) or (${table.allowOrganization} and not ${table.allowPersonal})`,
    ),
    index("execution_credential_definitions_org_idx").on(table.organizationId),
    uniqueIndex("execution_credential_definitions_org_key_uidx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export default executionCredentialDefinitionsTable;
