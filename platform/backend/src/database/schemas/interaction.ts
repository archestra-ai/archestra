import type { SupportedProviderDiscriminator } from "@shared";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { InteractionRequest, InteractionResponse } from "@/types";
import agentsTable from "./agent";
import usersTable from "./user";

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
    /**
     * Optional user ID passed via X-Archestra-User-Id header.
     * This allows clients to associate interactions with a specific Archestra user.
     * Particularly useful for identifying which user was using the Archestra Chat.
     */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /**
     * Session ID to group related LLM requests together.
     * Can be extracted from:
     * - X-Archestra-Session-Id header (explicit)
     * - Claude Code's metadata.user_id field (format: user_xxx_session_{uuid})
     * - OpenAI's user field
     */
    sessionId: varchar("session_id"),
    /**
     * Source of the session ID for display purposes.
     * Values: 'claude_code', 'header', 'openai_user', null
     */
    sessionSource: varchar("session_source"),
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
    userIdIdx: index("interactions_user_id_idx").on(table.userId),
    sessionIdIdx: index("interactions_session_id_idx").on(table.sessionId),
  }),
);

export default interactionsTable;
