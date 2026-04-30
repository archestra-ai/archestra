import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

const auditEventsTable = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdIdx: index("audit_events_organization_id_idx").on(
      table.organizationId,
    ),
    createdAtIdx: index("audit_events_created_at_idx").on(
      table.createdAt.desc(),
    ),
    actorUserIdIdx: index("audit_events_actor_user_id_idx").on(
      table.actorUserId,
    ),
    resourceTypeIdx: index("audit_events_resource_type_idx").on(
      table.resourceType,
    ),
  }),
);

export default auditEventsTable;
