import type { SupportedProvider } from "@archestra/shared";
import { desc, isNull, sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConversationOrigin } from "@/types/conversation";
import agentsTable from "./agent";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";
import projectsTable from "./project";
import { softDeletablePgTable } from "./soft-deletable-table";

// Note: Additional pg_trgm GIN index for search is created in migration 0116_pg_trgm_indexes.sql:
// - conversations_title_trgm_idx: GIN index on title column
const conversationsTable = softDeletablePgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    // Nullable to preserve conversations when agent is deleted
    // null indicates the agent was deleted
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    chatApiKeyId: uuid("chat_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      {
        onDelete: "set null",
      },
    ),
    title: text("title"),
    /** @deprecated Superseded by `modelId` (FK). Retained, no longer read or written. */
    selectedModel: text("selected_model").notNull().default("gpt-4o"),
    /** @deprecated Superseded by `modelId` (FK). Retained, no longer read or written. */
    selectedProvider: text("selected_provider").$type<SupportedProvider>(),
    /** FK to models(id) — the resolved model for this conversation. */
    modelId: uuid("model_id").references(() => modelsTable.id, {
      onDelete: "set null",
    }),
    hasCustomToolSelection: boolean("has_custom_tool_selection")
      .notNull()
      .default(false),
    /**
     * When true (and the viewer is an admin), hook runs in this conversation
     * surface inline as expandable debug chips. Toggled per-conversation via the
     * `/debug` chat command. See hooks/hook-run-parts.ts `stripHookRunParts`.
     */
    hooksDebugEnabled: boolean("hooks_debug_enabled").notNull().default(false),
    todoList:
      jsonb("todo_list").$type<
        Array<{
          id: number;
          content: string;
          status: "pending" | "in_progress" | "completed";
        }>
      >(),
    artifact: text("artifact"),
    /**
     * Project this chat was started in (forever — no moves in v1). SET NULL on
     * project delete: the chat survives as an ordinary conversation.
     */
    projectId: uuid("project_id").references(() => projectsTable.id, {
      onDelete: "set null",
    }),
    /**
     * How the chat was started; `schedule_trigger` marks a scheduled run's
     * chat, `app_open` a chat seeded by opening an app (a draft until the user
     * writes into it).
     */
    origin: text("origin")
      .$type<ConversationOrigin>()
      .notNull()
      .default("user"),
    /**
     * The stored `title` is a seeded stand-in rather than a real title: an
     * `app_open` chat is created titled with the app's name so the header and
     * sidebar have something to show before the first exchange (a null title
     * would read "New Chat Session" — an app draft has no user message for
     * `getConversationDisplayTitle` to fall back to). Title generation treats a
     * placeholder as untitled and replaces it. Cleared by any explicit title
     * write — generated or hand-typed — so generation fires once and can never
     * overwrite a name the user chose. Never set for `user` or
     * `schedule_trigger` origins.
     */
    titleIsPlaceholder: boolean("title_is_placeholder")
      .notNull()
      .default(false),
    pinnedAt: timestamp("pinned_at", { mode: "date" }),
    lastMessageAt: timestamp("last_message_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    /**
     * When the owner last viewed this conversation. Drives the sidebar
     * new-messages indicator: unread = lastMessageAt > lastReadAt. Null means
     * never explicitly read (fall back to createdAt when comparing).
     */
    lastReadAt: timestamp("last_read_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Project views count and list chats per project; without this the
    // per-project aggregation seq-scans conversations.
    index("conversations_project_id_idx").on(table.projectId),
    // Hot path: the sidebar list filters user+org and sorts by lastMessageAt
    // desc (ConversationModel.findAll). Composite so the lookup and the sort
    // are both served by one index; partial on active rows so soft-deleted
    // conversations neither bloat it nor cost writes when hidden.
    index("conversations_active_owner_last_message_idx")
      .on(table.userId, table.organizationId, desc(table.lastMessageAt))
      .where(sql`${table.deletedAt} IS NULL`),
    // The mirror of the index above, for the rows it deliberately excludes:
    // Deleted Items lists an org's trash and the purge sweep scans it by age.
    index("conversations_deleted_org_idx")
      .on(table.organizationId, table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  ],
);

export default conversationsTable;

/**
 * THE single source of truth for excluding soft-deleted conversations from
 * reads. Import this at every read site — in-model and cross-model joins —
 * instead of re-deriving `isNull(conversationsTable.deletedAt)` by hand, so a
 * new read path can't silently leak deleted rows.
 *
 * Placement rule: this is a `WHERE`-clause predicate and is correct ONLY when
 * `conversationsTable` is the base/inner table of the query. Where conversations
 * is LEFT JOINed (the optional side), adding it to `WHERE` silently turns the
 * LEFT JOIN into an INNER JOIN and drops parent rows — put it in the join's
 * `ON` clause instead. Deliberate non-consumers: billing/usage aggregates
 * (interaction, instance-usage) that must count deleted conversations too, and
 * the audit middleware (historical record). See the soft-delete plan.
 */
export const notDeletedConversation = isNull(conversationsTable.deletedAt);
