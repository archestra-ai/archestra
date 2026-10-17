import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
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
import type { ThreadCall, ThreadTool } from "@/types/openappa-thread-state";
import type {
  UnenforcedCallReason,
  UnenforcedSessionReason,
} from "@/types/openappa-unenforced";
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

// One row per trajectory family. The family's writers lock it for one
// read-decide-append step of the event log, so they take turns on the log
// instead of losing the append to each other. Nothing else is stored here.
export const openappaRootsTable = pgTable("openappa_roots", {
  root: text().primaryKey(),
});

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

// One row per deployment line; Archestra names each organization's line by its
// id. The head is the policy revision every decided append is fenced at: an
// append share-locks the row, and a publish moves the head by updating it.
export const openappaDeploymentsTable = pgTable(
  "openappa_deployments",
  {
    name: text().primaryKey(),
    head: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    check("openappa_deployments_head_positive", sql`${table.head} > 0`),
  ],
);

// Every revision a deployment published, and the policy file it names.
export const openappaPolicyRevisionsTable = pgTable(
  "openappa_policy_revisions",
  {
    deployment: text().notNull(),
    revision: bigint({ mode: "number" }).notNull(),
    hash: text().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "openappa_policy_revisions_pk",
      columns: [table.deployment, table.revision],
    }),
    foreignKey({
      name: "openappa_policy_revisions_deployment_fk",
      columns: [table.deployment],
      foreignColumns: [openappaDeploymentsTable.name],
    }),
    foreignKey({
      name: "openappa_policy_revisions_hash_fk",
      columns: [table.hash],
      foreignColumns: [openappaPolicyFilesTable.hash],
    }),
    check(
      "openappa_policy_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
    index("openappa_policy_revisions_key_idx").on(
      table.deployment,
      table.hash,
      table.revision,
    ),
  ],
);

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

// One row per receiver of held peer messages. Writers of one receiver's held
// messages lock it for one transaction, so the receiver's quota holds.
export const openappaPeerInboxesTable = pgTable("openappa_peer_inboxes", {
  receiver: text().primaryKey(),
});

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
    // The dispatch working on a pending receipt, and when its lease ends unless
    // it renews it. Another dispatch takes the receipt over only after that.
    // OpenAPPA sets both on every claim. The default covers a backend from
    // before leases that still claims receipts during an upgrade: its work is
    // treated as live for as long as such a dispatch can run.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).default(sql`now() + interval '15 minutes'`),
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
    // As on `openappa_operations`.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).default(sql`now() + interval '15 minutes'`),
    // A fork inherits only results completed before it opened.
    completedAt: timestamp("completed_at", { withTimezone: true }),
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

// The family lease earlier backends take for a whole dispatch. Receipts now
// carry their own leases and nothing here reads it; it stays while a backend
// that writes it may still run beside this one during an upgrade.
export const openappaDispatchLeasesTable = pgTable(
  "openappa_dispatch_leases",
  {
    root: text().primaryKey(),
    owner: text().notNull(),
    // The last event sequence of the root when the lease was taken, or -1 for
    // an empty log.
    eventSeq: bigint("event_seq", { mode: "number" }).notNull(),
    // Lease generation while this family retains pending receipts; not a retry limit.
    attempt: integer().notNull().default(1),
  },
  (table) => [
    check("openappa_dispatch_leases_attempt", sql`${table.attempt} >= 1`),
  ],
);

// The proxy writes the two tables below while Guardrails enforcement is off,
// and reads them while it is on. OpenAPPA ignores what they name: the part of
// a session that it did not see, or a session a person superyelled.

// Sessions OpenAPPA leaves alone. Most started while enforcement was off: the
// proxy saw a request of the session, and the runtime had no record of it. A
// person can also take a governed session out with an approved `superyell`.
// Such a session and the children it starts stay out of OpenAPPA.
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
    reason: text()
      .$type<UnenforcedSessionReason>()
      .notNull()
      .default("enforcement_off"),
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

// What the proxy needs to govern a server-side thread. A continue carries only
// the new messages and leaves the tools to the thread, so the proxy keeps what
// it ruled on: one row per governed model response, keyed by the response id
// the client names as `previous_message_id`.
export const openappaThreadStatesTable = pgTable(
  "openappa_thread_states",
  {
    organizationId: text("organization_id").notNull(),
    // The provider's id of the response this row follows.
    messageId: text("message_id").notNull(),
    // The caller-scoped session the thread belongs to.
    sessionId: text("session_id").notNull(),
    // The response that set the thread's tools: this one, or an earlier one.
    rootMessageId: text("root_message_id").notNull(),
    // The declared tools, kept on a root only: name, namespace, type, marker.
    tools: jsonb().$type<ThreadTool[]>(),
    // The tool calls the client holds for this response, as the client echoes
    // them: a continue carries only their results, and the ruling needs the
    // call each result answers.
    calls: jsonb().$type<ThreadCall[]>(),
    // The client holds a rewrite of this response that the provider's thread
    // cannot continue from, so the thread must be replayed.
    diverged: boolean().notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.messageId] }),
    index("openappa_thread_states_created_at_idx").on(table.createdAt),
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
