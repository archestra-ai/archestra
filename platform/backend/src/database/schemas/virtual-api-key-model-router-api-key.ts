import type { SupportedProvider } from "@shared";
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

const virtualApiKeyModelRouterApiKeysTable = pgTable(
  "virtual_api_key_model_router_api_key",
  {
    virtualApiKeyId: uuid("virtual_api_key_id")
      .notNull()
      .references(() => virtualApiKeysTable.id, { onDelete: "cascade" }),
    provider: text("provider").$type<SupportedProvider>().notNull(),
    chatApiKeyId: uuid("chat_api_key_id")
      .notNull()
      .references(() => llmProviderApiKeysTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.virtualApiKeyId, table.provider] }),
    index("idx_virtual_api_key_model_router_api_key_id").on(table.chatApiKeyId),
  ],
);

export default virtualApiKeyModelRouterApiKeysTable;
