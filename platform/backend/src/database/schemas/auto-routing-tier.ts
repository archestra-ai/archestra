import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import organizationsTable from "./organization";

/**
 * The model auto routing sends a tier's sessions to, and the provider key it
 * is sent with, like a model pool member. The key is shared with the whole
 * organization, so every chat and agent on `auto` may use it. Deleting the key
 * or the model removes the tier, and auto routing stops until it is set again.
 */
const autoRoutingTiersTable = pgTable(
  "auto_routing_tiers",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    tier: text("tier", { enum: ["fast", "normal", "smart"] }).notNull(),
    providerApiKeyId: uuid("provider_api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.tier] })],
);

export default autoRoutingTiersTable;
