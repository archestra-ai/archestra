import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeBaseVisibility } from "@/types/knowledge-base";

const knowledgeBasesTable = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility")
      .$type<KnowledgeBaseVisibility>()
      .notNull()
      .default("org-wide"),
    teamIds: jsonb("team_ids").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("knowledge_bases_organization_id_idx").on(table.organizationId),
  ],
);

export default knowledgeBasesTable;
