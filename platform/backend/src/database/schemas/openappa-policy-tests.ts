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

export const openappaPolicyTestSuitesTable = pgTable(
  "openappa_policy_test_suites",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    version: uuid().notNull().defaultRandom(),
    files: jsonb()
      .$type<{ path: string; content: string }[]>()
      .notNull()
      .default([]),
    directory: text().notNull().default("traces"),
    sourceCommit: text("source_commit"),
    sourceRevision: uuid("source_revision"),
  },
);

export const openappaPolicyTestRunsTable = pgTable(
  "openappa_policy_test_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    result: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("openappa_policy_test_runs_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);
