import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SupportedChatProvider } from "@/types";
import secretsTable from "./secret";

const chatApiKeysTable = pgTable(
  "chat_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").$type<SupportedChatProvider>().notNull(),
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      onDelete: "set null",
    }),
    isOrganizationDefault: boolean("is_organization_default")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Index for efficient lookups by organization
    index("chat_api_keys_organization_id_idx").on(table.organizationId),
    // Index for finding defaults by org + provider
    index("chat_api_keys_org_provider_idx").on(
      table.organizationId,
      table.provider,
    ),
    // Partial unique index: only one default per provider per organization
    uniqueIndex("chat_api_keys_org_provider_default_unique")
      .on(table.organizationId, table.provider)
      .where(sql`${table.isOrganizationDefault} = true`),
  ],
);

export default chatApiKeysTable;
