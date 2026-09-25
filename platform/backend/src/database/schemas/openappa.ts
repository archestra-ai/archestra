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
      columns: [table.sessionId, table.operationId],
    }),
    index("openappa_operations_pending_idx")
      .on(table.root)
      .where(sql`${table.status} = 'pending'`),
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
      columns: [table.sessionId, table.toolCallId],
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
