import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AppaProxyCallState,
  AppaProxySessionState,
} from "@/types/appa-proxy-session";

/**
 * Durable authority for an APPA-protected proxy conversation. The supplied
 * session id is only a locator: ownerScopeHash binds it to the authenticated
 * profile, credential, and principal without retaining any credential bytes.
 */
const appaProxySessionsTable = pgTable(
  "appa_proxy_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id").notNull(),
    ownerScopeHash: text("owner_scope_hash").notNull(),
    clientSessionId: text("client_session_id").notNull(),
    /**
     * Null only for pre-continuity rows. They are deliberately not backfilled:
     * their wire contract cannot be reconstructed safely.
     */
    provider: text("provider"),
    protocol: text("protocol"),
    model: text("model"),
    rootId: text("root_id").notNull(),
    state: text("state")
      .$type<AppaProxySessionState>()
      .notNull()
      .default("ready"),
    activeTurnId: text("active_turn_id"),
    /** Last APPA event whose result is not durably known. */
    pendingRemoteEvent: text("pending_remote_event"),
    rootInitializedAt: timestamp("root_initialized_at", { mode: "date" }),
    /** A child thread is attached only through a released parent spawn call. */
    parentSessionId: uuid("parent_session_id").references(
      (): AnyPgColumn => appaProxySessionsTable.id,
      { onDelete: "cascade" },
    ),
    parentCallId: text("parent_call_id"),
    childStartedAt: timestamp("child_started_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("appa_proxy_sessions_owner_session_uidx").on(
      table.ownerScopeHash,
      table.clientSessionId,
    ),
    index("appa_proxy_sessions_profile_id_idx").on(table.profileId),
    index("appa_proxy_sessions_parent_call_idx").on(
      table.parentSessionId,
      table.parentCallId,
    ),
    check(
      "appa_proxy_sessions_state_check",
      sql`${table.state} in ('ready', 'in_turn', 'quarantined')`,
    ),
  ],
);

/**
 * Calls the proxy actually emitted after dispatch rewrites. Result bodies never
 * persist here: only a keyed digest is retained once the result is admitted.
 */
export const appaProxyCallsTable = pgTable(
  "appa_proxy_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    emittedName: text("emitted_name").notNull(),
    emittedArguments: text("emitted_arguments").notNull(),
    emittedArgumentsCanonical: text("emitted_arguments_canonical").notNull(),
    appaTargetName: text("appa_target_name").notNull(),
    appaTargetArguments: jsonb("appa_target_arguments")
      .$type<Record<string, unknown>>()
      .notNull(),
    /** Runtime-owned dispatch identity, bound to the exact client call id. */
    dispatchId: text("dispatch_id"),
    /** A released spawn may open only the child bound by this runtime token. */
    spawnBinding: text("spawn_binding"),
    /** A spawn capability can attach exactly one child thread. */
    spawnBindingConsumedAt: timestamp("spawn_binding_consumed_at", {
      mode: "date",
    }),
    state: text("state").$type<AppaProxyCallState>().notNull(),
    resultHash: text("result_hash"),
    resultStatus: text("result_status"),
    resultMessageHash: text("result_message_hash"),
    resultPresentation: text("result_presentation"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("appa_proxy_calls_session_call_uidx").on(
      table.sessionId,
      table.callId,
    ),
    index("appa_proxy_calls_session_state_idx").on(
      table.sessionId,
      table.state,
    ),
    check(
      "appa_proxy_calls_state_check",
      sql`${table.state} in ('authorization_intent', 'open', 'result_intent', 'result_admitted', 'denied')`,
    ),
  ],
);

/** Exact v1 envelopes and receipts make retried runtime events auditable. */
export const appaProxyEventsTable = pgTable(
  "appa_proxy_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    event: text("event").notNull(),
    requestBody: text("request_body").notNull(),
    requestSha256: text("request_sha256").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    settledAt: timestamp("settled_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("appa_proxy_events_event_id_uidx").on(table.eventId),
    index("appa_proxy_events_session_id_idx").on(table.sessionId),
  ],
);

export default appaProxySessionsTable;
