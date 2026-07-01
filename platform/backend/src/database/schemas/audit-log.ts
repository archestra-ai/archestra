import {
  bigserial,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AuditActorType,
  AuditableSnapshot,
  AuditEventName,
  AuditOutcome,
} from "@/types/audit-log";
import organizationsTable from "./organization";
import usersTable from "./user";

const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic counter, postgres-assigned. Tiebreaks same-millisecond rows. */
    eventSequence: bigserial("event_sequence", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** When the audited action happened (stamped in preHandler / at better-auth callsite). */
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** When the audit row was persisted. */
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** FK still targets user.id for v1; actorType disambiguates session vs api_key actors. */
    actorId: text("actor_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    action: text("action").$type<AuditEventName>().notNull(),
    outcome: text("outcome").$type<AuditOutcome>().notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    before: jsonb("before").$type<AuditableSnapshot>(),
    after: jsonb("after").$type<AuditableSnapshot>(),
    httpMethod: text("http_method"),
    httpPath: text("http_path"),
    httpRoute: text("http_route"),
    httpStatus: integer("http_status"),
    requestId: text("request_id"),
    sourceIp: inet("source_ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    // Primary list query with same-ms tiebreak.
    index("audit_logs_org_created_at_seq_idx").on(
      table.organizationId,
      table.createdAt.desc(),
      table.eventSequence.desc(),
    ),
    // Actor filter.
    index("audit_logs_org_actor_created_at_idx").on(
      table.organizationId,
      table.actorId,
      table.createdAt.desc(),
    ),
    // "Who touched X" query.
    index("audit_logs_org_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
    ),
    // Action filter.
    index("audit_logs_org_action_created_at_idx").on(
      table.organizationId,
      table.action,
      table.createdAt.desc(),
    ),
    // Outcome filter ("show me all denied attempts").
    index("audit_logs_org_outcome_created_at_idx").on(
      table.organizationId,
      table.outcome,
      table.createdAt.desc(),
    ),
    // Retention sweep.
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

export default auditLogsTable;
