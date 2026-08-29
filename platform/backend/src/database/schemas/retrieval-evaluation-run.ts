import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  KnowledgeEvaluationComponent,
  RetrievalEvaluationRunStage,
  RetrievalEvaluationRunStatus,
  RetrievalEvaluationSettingsOverrides,
} from "@/types/retrieval-evaluation";
import organizationsTable from "./organization";
import tasksTable from "./task";
import usersTable from "./user";

const retrievalEvaluationRunsTable = pgTable(
  "retrieval_evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    taskId: uuid("task_id").references(() => tasksTable.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    queryLimit: integer("query_limit").notNull().default(10),
    selectedComponents: jsonb("selected_components")
      .$type<KnowledgeEvaluationComponent[]>()
      .notNull()
      .default([]),
    settingsOverrides: jsonb("settings_overrides")
      .$type<RetrievalEvaluationSettingsOverrides>()
      .notNull()
      .default({}),
    componentFingerprints: jsonb("component_fingerprints")
      .$type<Partial<Record<KnowledgeEvaluationComponent, string>>>()
      .notNull()
      .default({}),
    status: text("status")
      .$type<RetrievalEvaluationRunStatus>()
      .notNull()
      .default("queued"),
    stage: text("stage")
      .$type<RetrievalEvaluationRunStage>()
      .notNull()
      .default("queued"),
    progressCurrent: integer("progress_current").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    progressMessage: text("progress_message"),
    fixtureKnowledgeBaseId: uuid("fixture_knowledge_base_id"),
    fixtureConnectorId: uuid("fixture_connector_id"),
    bm25Refreshed: boolean("bm25_refreshed").notNull().default(false),
    artifact: jsonb("artifact").$type<Record<string, unknown>>(),
    error: text("error"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      mode: "date",
    }),
    startedAt: timestamp("started_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [
    index("retrieval_evaluation_runs_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("retrieval_evaluation_runs_task_idx").on(table.taskId),
    index("retrieval_evaluation_runs_global_execution_idx")
      .on(table.status, table.startedAt)
      .where(sql`${table.status} IN ('running', 'cancel_requested')`),
    uniqueIndex("retrieval_evaluation_runs_one_active_per_org_idx")
      .on(table.organizationId)
      .where(sql`${table.status} IN ('queued', 'running', 'cancel_requested')`),
  ],
);

export default retrievalEvaluationRunsTable;
