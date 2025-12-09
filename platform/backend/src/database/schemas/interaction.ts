import {
  index,
  integer,
  jsonb,
  numeric,
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
    profileId: uuid("profile_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /**
     * Optional external agent ID passed via X-Archestra-Agent-Id header.
     * This allows clients to associate interactions with their own agent identifiers.
     */
    externalAgentId: varchar("external_agent_id"),
    request: jsonb("request").$type<InteractionRequest>().notNull(),
    processedRequest: jsonb("processed_request").$type<InteractionRequest>(),
    response: jsonb("response").$type<InteractionResponse>().notNull(),
    type: varchar("type").$type<SupportedProviderDiscriminator>().notNull(),
    model: varchar("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    baselineCost: numeric("baseline_cost", { precision: 13, scale: 10 }),
    cost: numeric("cost", { precision: 13, scale: 10 }),
    toonTokensBefore: integer("toon_tokens_before"),
    toonTokensAfter: integer("toon_tokens_after"),
    toonCostSavings: numeric("toon_cost_savings", { precision: 13, scale: 10 }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    profileIdIdx: index("interactions_agent_id_idx").on(table.profileId),
    externalAgentIdIdx: index("interactions_external_agent_id_idx").on(
      table.externalAgentId,
    ),
  }),
);

export default interactionsTable;
