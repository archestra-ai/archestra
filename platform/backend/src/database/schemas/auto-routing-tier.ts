import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import autoRoutersTable from "./auto-router";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";

/**
 * The model an auto router sends a tier's sessions to, and the provider key
 * it is sent with, like a model pool member. The key is shared with the whole
 * organization, so every chat and agent on the router may use it. Deleting
 * the key or the model removes the tier, and the router stops routing until
 * it is set again.
 */
const autoRoutingTiersTable = pgTable(
  "auto_routing_tiers",
  {
    routerId: uuid("router_id")
      .notNull()
      .references(() => autoRoutersTable.id, { onDelete: "cascade" }),
    tier: text("tier", { enum: ["fast", "normal", "smart"] }).notNull(),
    providerApiKeyId: uuid("provider_api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.routerId, table.tier] }),
    // Back the cascades from provider keys and models.
    index("auto_routing_tiers_provider_api_key_id_idx").on(
      table.providerApiKeyId,
    ),
    index("auto_routing_tiers_model_id_idx").on(table.modelId),
  ],
);

export default autoRoutingTiersTable;
