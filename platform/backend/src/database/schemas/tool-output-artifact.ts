import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolOutputStatus } from "@/types/tool-output-offload";
import conversationsTable from "./conversation";

const toolOutputArtifactsTable = pgTable(
  "tool_output_artifacts",
  {
    id: text("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id"),
    toolResultId: text("tool_result_id").notNull(),
    toolName: text("tool_name").notNull(),
    status: text("status").$type<ToolOutputStatus>().notNull(),
    rawInputJson: jsonb("raw_input_json").$type<unknown>(),
    rawOutputJson: jsonb("raw_output_json").$type<unknown>(),
    rawOutputText: text("raw_output_text"),
    sizeBytes: integer("size_bytes").notNull(),
    estimatedTokens: integer("estimated_tokens"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdIdx: index("idx_tool_output_artifacts_conversation_id").on(
      table.conversationId,
    ),
  }),
);

export default toolOutputArtifactsTable;
