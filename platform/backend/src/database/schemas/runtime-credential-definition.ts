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
import type { CredentialKind } from "@/types/runtime-credential-definition";
import serviceAccountsTable from "./service-account";
import usersTable from "./user";

/** Reusable credential definitions shared by every platform consumer. */
const runtimeCredentialDefinitionsTable = pgTable(
  "credential_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<CredentialKind>().notNull().default("secret"),
    githubUrl: text("github_url"),
    appId: text("app_id"),
    installationId: text("installation_id"),
    githubClientId: text("github_client_id"),
    githubAppCredentialKey: text("github_app_credential_key"),
    description: text("description").notNull().default(""),
    icon: text("icon"),
    allowPersonal: boolean("allow_personal").notNull().default(true),
    allowOrganization: boolean("allow_organization").notNull().default(false),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /** Service account creator; separate from human ownership. */
    createdByServiceAccountId: uuid("created_by_service_account_id").references(
      () => serviceAccountsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "credential_definitions_scope_check",
      sql`(${table.allowPersonal} and not ${table.allowOrganization}) or (${table.allowOrganization} and not ${table.allowPersonal})`,
    ),
    index("credential_definitions_org_idx").on(table.organizationId),
    uniqueIndex("credential_definitions_org_key_uidx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export default runtimeCredentialDefinitionsTable;
