import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import secretsTable from "./secret";

const chatSettingsTable = pgTable("chat_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().unique(),
  provider: text("provider").notNull().default("anthropic"), // 'anthropic' or 'openai'
  model: text("model"), // Selected model name (e.g., 'claude-opus-4-1-20250805')
  anthropicApiKeySecretId: uuid("anthropic_api_key_secret_id").references(
    () => secretsTable.id,
    { onDelete: "set null" },
  ),
  openaiApiKeySecretId: uuid("openai_api_key_secret_id").references(
    () => secretsTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default chatSettingsTable;
