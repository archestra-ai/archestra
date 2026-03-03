import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import secretTable from "./secret";

const knowledgeGraphsTable = pgTable(
  "knowledge_graphs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    seededFromEnv: boolean("seeded_from_env").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("knowledge_graphs_organization_id_idx").on(table.organizationId),
  ],
);

export default knowledgeGraphsTable;
