import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  InteractionRequest,
  InteractionResponse,
  SupportedProviderDiscriminator,
} from "@/types";
import agentsTable from "./agent";

const interactionsTable = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    request: jsonb("request").$type<InteractionRequest>().notNull(),
    response: jsonb("response").$type<InteractionResponse>().notNull(),
    type: varchar("type").$type<SupportedProviderDiscriminator>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("interactions_agent_id_idx").on(table.agentId),
  }),
);

export default interactionsTable;
