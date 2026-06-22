import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import conversationsTable from "./conversation";
import usersTable from "./user";

/**
 * Binds an App Builder conversation to the app it builds (FR-25). A "New App"
 * action opens a builder conversation with no app yet (`appId` null); its first
 * `create_app` claims the row, associating the created app to that editor. At
 * most one builder conversation exists per `(app, editor)` (LIM-19), enforced by
 * the partial unique index below; reopening an app resumes that row's
 * conversation. The conversation outlives the binding: deleting the app severs
 * the binding (the row is removed) but the conversation remains as ordinary chat
 * history.
 */
const appBuilderConversationsTable = pgTable(
  "app_builder_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** The builder conversation; one builder row per conversation. */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    /**
     * The app this conversation builds. Null until the conversation's first
     * `create_app` binds it (the draft state). Severed (row deleted) when the
     * app is deleted, so a soft-delete frees the editor to build anew.
     */
    appId: uuid("app_id").references(() => appsTable.id, {
      onDelete: "cascade",
    }),
    /** The editor (user authorized to create/modify the app) this builder is for. */
    editorUserId: text("editor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("app_builder_conversations_conversation_id_idx").on(
      table.conversationId,
    ),
    index("app_builder_conversations_app_id_idx").on(table.appId),
    // One builder conversation per (app, editor) — LIM-19. Draft rows (appId
    // null) are excluded, so an editor may hold many unbound drafts but only one
    // bound builder per app.
    uniqueIndex("app_builder_conversations_app_editor_idx")
      .on(table.appId, table.editorUserId)
      .where(sql`${table.appId} IS NOT NULL`),
  ],
);

export default appBuilderConversationsTable;
