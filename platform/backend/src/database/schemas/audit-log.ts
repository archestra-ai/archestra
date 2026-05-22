import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AuditLogMetadata } from "@/types";
import organizationsTable from "./organization";
import usersTable from "./user";

const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 255 }).notNull(),
    resource: varchar("resource", { length: 255 }).notNull(),
    resourceId: varchar("resource_id", { length: 255 }),
    metadata: jsonb("metadata").$type<AuditLogMetadata>().notNull().default({
      ip: null,
      userAgent: null,
      diff: null,
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdIdx: index("audit_logs_organization_id_idx").on(
      table.organizationId,
    ),
    userIdIdx: index("audit_logs_user_id_idx").on(table.userId),
    actionIdx: index("audit_logs_action_idx").on(table.action),
    createdAtIdx: index("audit_logs_created_at_idx").on(
      table.createdAt.desc(),
    ),
    orgCreatedAtIdx: index("audit_logs_org_created_at_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    actionResourceIdx: index("audit_logs_action_resource_idx").on(
      table.action,
      table.resource,
    ),
  }),
);

export default auditLogsTable;
