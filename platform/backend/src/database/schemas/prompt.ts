import type { IncomingEmailSecurityMode } from "@shared";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ChatOpsProviderType, PromptHistoryEntry } from "@/types";
import agentsTable from "./agent";

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
  // Incoming email settings
  incomingEmailEnabled: boolean("incoming_email_enabled")
    .notNull()
    .default(false),
  // Security mode: 'private' (user auth), 'internal' (domain), 'public' (no restriction)
  incomingEmailSecurityMode: text("incoming_email_security_mode")
    .$type<IncomingEmailSecurityMode>()
    .notNull()
    .default("private"),
  // Allowed email domain for 'internal' mode (e.g., 'company.com')
  incomingEmailAllowedDomain: text("incoming_email_allowed_domain"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default promptsTable;
