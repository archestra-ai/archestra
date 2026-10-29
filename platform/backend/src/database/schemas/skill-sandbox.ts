import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import conversationsTable from "./conversation";
import serviceAccountsTable from "./service-account";
import usersTable from "./user";

/**
 * Code execution sandbox: durable recipe for a Dagger-materialized container
 * that replays an ordered log of commands, uploads, and skill mounts.
 *
 * Postgres is the source of truth for the recipe (this row + replay log +
 * payload tables). Dagger owns filesystem state and has no retention
 * guarantees — sandboxes are replayed from the log when the cache is cold.
 *
 * Each conversation has at most one `isDefault` sandbox, created lazily on the
 * first command/upload/skill activation; explicit `{fresh}` sandboxes have
 * `isDefault = false`.
 *
 * An MCP App runtime has no conversation, so its default sandbox is keyed by
 * `app_id` instead: exactly one per (org, user, app), and every sandbox-backed
 * capability an app uses resolves to that single instance.
 */
const skillSandboxesTable = pgTable(
  "skill_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** Owning person; null when a service account owns the sandbox. */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    /** Owning service account; null when a person owns the sandbox. */
    serviceAccountId: uuid("service_account_id").references(
      () => serviceAccountsTable.id,
      { onDelete: "cascade" },
    ),
    /**
     * Conversation the sandbox was created from, when known. Deleting the
     * conversation (retention sweep) deletes its sandboxes and their files.
     */
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "cascade" },
    ),
    /**
     * MCP App the sandbox belongs to; null = not an app sandbox. Mutually
     * exclusive with `conversation_id` in practice — an app runtime carries no
     * conversation.
     */
    appId: uuid("app_id").references(() => appsTable.id, {
      onDelete: "cascade",
    }),
    /**
     * The context's implicit default sandbox. At most one per
     * (org, user, conversation) and one per (org, user, app) — enforced by the
     * partial unique indexes below so concurrent first calls cannot create two
     * defaults.
     */
    isDefault: boolean("is_default").notNull().default(false),
    /** Working directory used when a command does not provide an explicit cwd. */
    defaultCwd: text("default_cwd").notNull(),
    /**
     * Next replay sequence to allocate for this sandbox. Bumped atomically when
     * a command, upload, or skill-mount event is appended, giving every replay
     * event a stable total order independent of clock skew or insert timing.
     */
    nextReplaySequence: integer("next_replay_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandboxes_organization_id_idx").on(table.organizationId),
    index("skill_sandboxes_user_id_idx").on(table.userId),
    index("skill_sandboxes_service_account_id_idx").on(table.serviceAccountId),
    index("skill_sandboxes_conversation_id_idx").on(table.conversationId),
    index("skill_sandboxes_app_id_idx").on(table.appId),
    uniqueIndex("skill_sandboxes_default_uidx")
      .on(table.organizationId, table.userId, table.conversationId)
      .where(sql`${table.isDefault}`),
    // The index above cannot protect an app's default: its conversation_id is
    // NULL and Postgres treats NULLs as distinct, so (org, user, NULL) would
    // admit unlimited defaults. Key the app's on app_id instead.
    uniqueIndex("skill_sandboxes_app_default_uidx")
      .on(table.organizationId, table.userId, table.appId)
      .where(sql`${table.isDefault} AND ${table.appId} IS NOT NULL`),
    // A service account's rows have a NULL user_id, which the indexes above
    // treat as distinct; key its defaults on service_account_id instead.
    uniqueIndex("skill_sandboxes_service_account_default_uidx")
      .on(table.organizationId, table.serviceAccountId, table.conversationId)
      .where(sql`${table.isDefault} AND ${table.serviceAccountId} IS NOT NULL`),
    uniqueIndex("skill_sandboxes_service_account_app_default_uidx")
      .on(table.organizationId, table.serviceAccountId, table.appId)
      .where(
        sql`${table.isDefault} AND ${table.serviceAccountId} IS NOT NULL AND ${table.appId} IS NOT NULL`,
      ),
    check(
      "skill_sandboxes_owner_chk",
      sql`num_nonnulls(${table.userId}, ${table.serviceAccountId}) = 1`,
    ),
  ],
);

export default skillSandboxesTable;
