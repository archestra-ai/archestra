import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import knowledgeBasesTable from "./knowledge-base";
import projectsTable from "./project";

const projectKnowledgeBasesTable = pgTable(
  "project_knowledge_base",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.knowledgeBaseId] }),
    index("project_knowledge_base_project_idx").on(table.projectId),
    index("project_knowledge_base_kb_idx").on(table.knowledgeBaseId),
  ],
);

export default projectKnowledgeBasesTable;
