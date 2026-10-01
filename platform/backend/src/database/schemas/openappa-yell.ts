import {
  boolean,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType: () => "bytea",
});

export const openappaYellsTable = pgTable(
  "openappa_yells",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    callerId: text("caller_id").notNull(),
    sessionId: text("session_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    archive: bytea("archive"),
    message: text("message").notNull(),
    withTrajectory: boolean("with_trajectory").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    reportFailed: boolean("report_failed").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (table) => [
    uniqueIndex("openappa_yells_call_idx").on(
      table.organizationId,
      table.callerId,
      table.sessionId,
      table.toolCallId,
    ),
    index("openappa_yells_status_idx").on(
      table.organizationId,
      table.resolvedAt,
      table.createdAt,
      table.id,
    ),
  ],
);
