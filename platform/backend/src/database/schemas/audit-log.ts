import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AuditAction, AuditableSnapshot } from "@/types/audit-log";
import organizationsTable from "./organization";
import usersTable from "./user";

const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    action: text("action").$type<AuditAction>().notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    priorState: jsonb("prior_state").$type<AuditableSnapshot>(),
    postState: jsonb("post_state").$type<AuditableSnapshot>(),
    httpMethod: text("http_method"),
    httpPath: text("http_path"),
    httpRoute: text("http_route"),
    httpStatus: integer("http_status"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_org_created_at_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    index("audit_logs_org_actor_created_at_idx").on(
      table.organizationId,
      table.actorUserId,
      table.createdAt.desc(),
    ),
    index("audit_logs_org_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
    ),
    index("audit_logs_org_action_created_at_idx").on(
      table.organizationId,
      table.action,
      table.createdAt.desc(),
    ),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

export default auditLogsTable;
