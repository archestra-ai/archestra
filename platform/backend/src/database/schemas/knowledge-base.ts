import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  KnowledgeBaseProviderType,
  LightragConfig,
} from "@/types/knowledge-base";
import secretTable from "./secret";

const knowledgeBasesTable = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").$type<KnowledgeBaseProviderType>().notNull(),
    config: jsonb("config").$type<LightragConfig>().notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
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
