import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { OpenAppaYellKind } from "@/types/openappa-yell";
import conversationsTable from "./conversation";
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
    // Sent through superyell, which also turned guardrails off for the session.
    superyell: boolean("superyell").notNull().default(false),
    // Who raised it: the agent's own `yell` call, or the platform when it let
    // a blocked call through under the Break the glass settings.
    kind: text("kind").$type<OpenAppaYellKind>().notNull().default("agent"),
    // How many calls a platform yell stands for: repeats of the same tool and
    // kind in a session add to one yell.
    count: integer("count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    reportFailed: boolean("report_failed").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
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
    index("openappa_yells_conversation_id_idx").on(table.conversationId),
  ],
);
