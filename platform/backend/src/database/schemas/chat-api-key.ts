import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import secretsTable from "./secret";

const chatApiKeysTable = pgTable(
  "chat_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(), // 'anthropic' | 'openai'
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
    // Only one default per organization per provider
    unique("chat_api_keys_org_provider_default_unique")
      .on(table.organizationId, table.provider)
      .nullsNotDistinct(),
  ],
);

export default chatApiKeysTable;
