import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ChatOpsProviderType } from "@/types/chatops";
import agentsTable from "./agent";

/**
 * Represents a historical version of a prompt stored in the history JSONB array
 */
export interface PromptHistoryEntry {
  version: number;
  userPrompt: string | null;
  systemPrompt: string | null;
  createdAt: string; // ISO timestamp
}

const promptsTable = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  userPrompt: text("user_prompt"),
  systemPrompt: text("system_prompt"),
  version: integer("version").notNull().default(1),
  history: jsonb("history").$type<PromptHistoryEntry[]>().notNull().default([]),
  /** Which chatops providers can trigger this prompt/agent (empty = none) */
  allowedChatops: jsonb("allowed_chatops")
    .$type<ChatOpsProviderType[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default promptsTable;
