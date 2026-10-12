import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ExternalConsultBackend,
  ExternalConsultOutcome,
  ExternalConsultRole,
} from "@/types/openappa-external-consults";
import type { UnenforcedCallReason } from "@/types/openappa-unenforced";
import organizationsTable from "./organization";

// The payload and policy bytes belong to OpenAPPA. TypeScript never decodes
// event batches or rebuilds the policy projection.
const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType: () => "bytea",
});
export const openappaEventsTable = pgTable(
  "openappa_events",
  {
    root: text().notNull(),
    seq: bigint({ mode: "number" }).notNull(),
    payload: bytea("payload").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.root, table.seq] }),
    check("openappa_events_seq_nonnegative", sql`${table.seq} >= 0`),
  ],
);

export const openappaHostKeysTable = pgTable(
  "openappa_host_keys",
  {
    key: text().notNull(),
    root: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.root] }),
    index("openappa_host_keys_root_idx").on(table.root),
  ],
);

export const openappaPolicyFilesTable = pgTable("openappa_policy_files", {
  hash: text().primaryKey(),
  bytes: bytea("bytes").notNull(),
});

/** Required by the shared runtime's PostgreSQL store, including embedded hosts. */
export const openappaHeldPeerMessagesTable = pgTable(
  "openappa_held_peer_messages",
  {
    seq: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: text().notNull().unique(),
    receiver: text().notNull(),
    digest: text().notNull(),
    label: jsonb().notNull(),
    body: text().notNull(),
    expiresAt: bigint({ mode: "number" }).notNull(),
    notified: boolean().notNull().default(false),
  },
  (table) => [
    index("openappa_held_peer_messages_receiver_idx").on(
      table.receiver,
      table.seq,
    ),
  ],
);

/** Runtime-owned peer values. Label capture and admission stay inside OpenAPPA. */
export const openappaEmbeddedPeerMessagesTable = pgTable(
  "openappa_embedded_peer_messages",
  {
    seq: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: text().notNull().unique(),
    root: text().notNull(),
    sender: text().notNull(),
    recipient: text().notNull(),
    pendingSpawn: text(),
    dispatch: text().notNull(),
    digest: text().notNull(),
    label: jsonb().notNull(),
    body: text(),
    status: text().notNull(),
    readCallId: text(),
    readArguments: text(),
    decision: jsonb(),
    expiresAt: bigint({ mode: "number" }).notNull(),
    createdAt: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("openappa_embedded_peer_dispatch_uidx").on(
      table.root,
      table.sender,
      table.dispatch,
    ),
    index("openappa_embedded_peer_recipient_idx").on(
      table.root,
      table.recipient,
      table.status,
    ),
    uniqueIndex("openappa_embedded_peer_read_call_uidx")
      .on(table.root, table.recipient, table.readCallId)
      .where(sql`${table.readCallId} IS NOT NULL`),
    check(
      "openappa_embedded_peer_status",
      sql`${table.status} IN ('held', 'direct', 'read')`,
    ),
  ],
);

const scope = () => ({
  organizationId: text("organization_id").notNull(),
  // Optional audit attribution; participants share one session.
  callerId: text("caller_id"),
  sessionId: text("session_id").notNull(),
});

export const openappaSessionsTable = pgTable(
  "openappa_sessions",
  {
    actor: text().notNull(),
    root: text().notNull(),
    ...scope(),
    parentId: text("parent_id"),
    // Independent-root source, used to validate lineage and locate inherited
    // result receipts. parentId instead identifies a shared-family subagent.
    forkedFrom: text("forked_from"),
    // Parent-lock-protected cutoff for receipts claimed before the fork. A NULL
    // cutoff after crash recovery deliberately inherits no result receipts.
    forkedAt: timestamp("forked_at", { withTimezone: true }),
    receiptToken: text("receipt_token"),
    receiptIssuedAt: timestamp("receipt_issued_at", { withTimezone: true }),
    startDecision: jsonb("start_decision").notNull(),
  },
  (table) => [
    // Client session ids may repeat across organizations; the actor alone does not.
    primaryKey({ columns: [table.organizationId, table.actor] }),
    index("openappa_sessions_root_idx").on(table.root),
    index("openappa_sessions_forked_from_idx").on(
      table.organizationId,
      table.forkedFrom,
    ),
    index("openappa_sessions_unscoped_session_idx").on(
      table.organizationId,
      sql`substr(${table.sessionId}, strpos(${table.sessionId}, '|') + 1)`,
    ),
    uniqueIndex("openappa_sessions_org_receipt_token_uidx")
      .on(table.organizationId, table.receiptToken)
      .where(sql`${table.receiptToken} IS NOT NULL`),
  ],
);

export const openappaOperationsTable = pgTable(
  "openappa_operations",
  {
    ...scope(),
    operationId: text("operation_id").notNull(),
    root: text().notNull(),
    status: text().notNull(),
    input: jsonb().notNull(),
    decision: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "openappa_operations_pk",
      columns: [table.organizationId, table.sessionId, table.operationId],
    }),
    index("openappa_operations_pending_idx")
      .on(table.root)
      .where(sql`${table.status} = 'pending'`),
    // The overview's activity chart reads one organization's recent rows.
    index("openappa_operations_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check(
      "openappa_operations_status",
      sql`(${table.status} = 'pending' AND ${table.decision} IS NULL) OR (${table.status} = 'complete' AND ${table.decision} IS NOT NULL)`,
    ),
  ],
);

export const openappaProcessedResultsTable = pgTable(
  "openappa_processed_results",
  {
    ...scope(),
    toolCallId: text("tool_call_id").notNull(),
    root: text().notNull(),
    status: text().notNull(),
    approvedOutput: text("approved_output"),
    decision: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "openappa_results_pk",
      columns: [table.organizationId, table.sessionId, table.toolCallId],
    }),
    index("openappa_results_pending_idx")
      .on(table.root)
      .where(sql`${table.status} = 'pending'`),
    check(
      "openappa_results_status",
      sql`(${table.status} = 'pending' AND ${table.approvedOutput} IS NULL AND ${table.decision} IS NULL) OR (${table.status} = 'complete' AND ${table.approvedOutput} IS NOT NULL AND ${table.decision} IS NOT NULL)`,
    ),
  ],
);

// The proxy writes the two tables below only while Guardrails enforcement is
// off, and reads them while it is on. OpenAPPA ignores what they name: the
// part of a session that it did not see.

// Sessions that started while enforcement was off: the proxy saw a request of
// the session, and the runtime had no record of it. Such a session and the
// children it starts stay out of OpenAPPA after enforcement turns on.
export const openappaUnenforcedSessionsTable = pgTable(
  "openappa_unenforced_sessions",
  {
    organizationId: text("organization_id").notNull(),
    // The caller-scoped id, as `openappa_sessions.session_id` holds it.
    sessionId: text("session_id").notNull(),
    // For a child, the session that started it. A child's id joins its
    // parent's id and its own, so the parent tells it apart from a root that
    // has the same id.
    parentId: text("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.sessionId] })],
);

// Tool calls of a governed session whose outcome the runtime did not see,
// because enforcement was off: a call the model made then (`made`), and a
// spawn whose child ran or got a message then (`child`). A record covers only
// the session whose history holds the call.
export const openappaUnenforcedCallsTable = pgTable(
  "openappa_unenforced_calls",
  {
    organizationId: text("organization_id").notNull(),
    // The caller-scoped id of the session that made the call.
    sessionId: text("session_id").notNull(),
    // The provider's call id, without a trajectory stamp.
    toolCallId: text("tool_call_id").notNull(),
    reason: text().$type<UnenforcedCallReason>().notNull(),
    // For a spawn: the client's id of the child it started, when known.
    childNativeId: text("child_native_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.sessionId, table.toolCallId],
    }),
  ],
);

// One row per external consult the native runtime made, written by Rust after
// the dispatch returns. A dataset for export, never read by a decision.
export const openappaExternalConsultsTable = pgTable(
  "openappa_external_consults",
  {
    // UUID v7, minted by the runtime.
    id: uuid().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    callerId: text("caller_id"),
    // Milliseconds, as a JS Date holds them: the export's keyset cursor
    // round-trips this value exactly.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    role: text().$type<ExternalConsultRole>().notNull(),
    externalName: text("external_name").notNull(),
    backend: text().$type<ExternalConsultBackend>().notNull(),
    request: jsonb().notNull(),
    outcome: text().$type<ExternalConsultOutcome>().notNull(),
    answer: jsonb(),
    rawResponse: bytea("raw_response"),
    httpStatus: integer("http_status"),
    diagnostics: bytea("diagnostics"),
    diagnosticsTruncated: boolean("diagnostics_truncated")
      .notNull()
      .default(false),
    root: text().notNull(),
    trajectory: text().notNull(),
    callId: text("call_id"),
    offerId: text("offer_id"),
    callDigest: text("call_digest"),
  },
  (table) => [
    index("openappa_external_consults_org_created_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    index("openappa_external_consults_created_idx").on(table.createdAt),
    index("openappa_external_consults_root_idx").on(table.root),
  ],
);
