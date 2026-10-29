import type { SupportedProvider } from "@archestra/shared";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * Provider API keys a standard virtual key routes to. A virtual key holds one
 * key per provider, except for providers whose keys are separate servers with
 * their own models (`providerHasEndpointLocalModels`): there each key is
 * another endpoint, and requests pick the one that serves the model. That rule
 * is enforced where mappings are written, not here.
 */
const virtualApiKeyProviderApiKeysTable = pgTable(
  "virtual_api_key_provider_api_key",
  {
    virtualApiKeyId: uuid("virtual_api_key_id")
      .notNull()
      .references(() => virtualApiKeysTable.id, { onDelete: "cascade" }),
    provider: text("provider").$type<SupportedProvider>().notNull(),
    providerApiKeyId: uuid("provider_api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "virtual_api_key_provider_api_key_pk",
      columns: [table.virtualApiKeyId, table.providerApiKeyId],
    }),
    index("idx_virtual_api_key_provider_api_key_id").on(table.providerApiKeyId),
  ],
);

export default virtualApiKeyProviderApiKeysTable;
