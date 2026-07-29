import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { A2AProtocolPart } from "@/agents/a2a/a2a-protocol";
import a2aTaskTable from "./a2a-task";

/**
 * A2A task artifacts — the durable outputs of a task, distinct from its
 * conversational message history (A2A v1.0 §3.7: results SHOULD be delivered
 * as artifacts; history is lossy). The row id doubles as the protocol
 * `artifactId`. A row is created together with its first non-empty part inside
 * the first delta-append transaction of a run, and its `parts` are extended in
 * later append transactions — so an artifact can never be observed with zero
 * parts, and a task snapshot always reconstructs every chunk already emitted.
 */
const a2aArtifactTable = pgTable(
  "a2a_artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTaskTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    parts: jsonb("parts").$type<A2AProtocolPart[]>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("a2a_artifact_task_id_idx").on(table.taskId)],
);

export default a2aArtifactTable;
