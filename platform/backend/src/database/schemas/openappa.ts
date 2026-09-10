import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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

export const openappaPolicyFilesTable = pgTable("openappa_policy_files", {
  hash: text().primaryKey(),
  bytes: bytea("bytes").notNull(),
});

const scope = () => ({
  organizationId: text("organization_id").notNull(),
  callerId: text("caller_id").notNull(),
  sessionId: text("session_id").notNull(),
});

export const openappaSessionsTable = pgTable(
  "openappa_sessions",
  {
    actor: text().primaryKey(),
    root: text().notNull(),
    ...scope(),
    parentId: text("parent_id"),
    startDecision: jsonb("start_decision").notNull(),
  },
  (table) => [index("openappa_sessions_root_idx").on(table.root)],
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
      columns: [
        table.organizationId,
        table.callerId,
        table.sessionId,
        table.operationId,
      ],
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
      columns: [
        table.organizationId,
        table.callerId,
        table.sessionId,
        table.toolCallId,
      ],
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
