import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import membersTable from "./member";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * Audit log table — records who performed an action, what action was performed,
 * on which resource, when, and from which IP address.
 *
 * Each entry is immutable. Entries are never updated or deleted so the log
 * remains an accurate historical record.
 */
const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),

    /** The organization this event belongs to */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),

    /** User who performed the action (null for system-initiated events) */
    actorId: text("actor_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),

    /** Denormalized display name so the log remains readable even if the user
     *  is later deleted */
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),

    /** High-level category: "agent" | "member" | "team" | "organization" |
     *  "api_key" | "llm" | "auth" | … */
    resourceType: text("resource_type").notNull(),

    /** Primary key or human-readable identifier of the affected resource */
    resourceId: text("resource_id"),

    /** Human-readable label for the affected resource (e.g. agent name) */
    resourceLabel: text("resource_label"),

    /** Verb describing the operation: "created" | "updated" | "deleted" |
     *  "invited" | "removed" | "login" | "logout" | … */
    action: text("action").notNull(),

    /** Optional JSON blob with before/after state or extra context */
    metadata: text("metadata"),

    /** Client IP address extracted from the request */
    ipAddress: text("ip_address"),

    /** Timestamp of the event (defaults to now) */
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    orgIdIdx: index("idx_audit_logs_organization_id").on(table.organizationId),
    actorIdIdx: index("idx_audit_logs_actor_id").on(table.actorId),
    createdAtIdx: index("idx_audit_logs_created_at").on(table.createdAt),
    resourceTypeIdx: index("idx_audit_logs_resource_type").on(
      table.resourceType,
    ),
  }),
);

export default auditLogsTable;
