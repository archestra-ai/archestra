import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import a2aTasksTable from "./a2a-task";
import usersTable from "./user";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** Files supplied with the first instruction of an isolated Agent execution. */
const agentExecutionInputsTable = pgTable(
  "agent_execution_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTasksTable.id, { onDelete: "cascade" }),
    uploadedByUserId: text("uploaded_by_user_id").references(
      () => usersTable.id,
      { onDelete: "cascade" },
    ),
    originalName: text("original_name").notNull(),
    runtimePath: text("runtime_path").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    fileData: bytea("file_data").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_execution_inputs_task_id_idx").on(table.taskId),
    index("agent_execution_inputs_organization_id_idx").on(
      table.organizationId,
    ),
    uniqueIndex("agent_execution_inputs_task_path_uidx").on(
      table.taskId,
      table.runtimePath,
    ),
  ],
);

export default agentExecutionInputsTable;
