import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

const k8sClustersTable = pgTable("k8s_cluster", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kubeconfig: jsonb("kubeconfig").$type<{ __encrypted: string }>().notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default k8sClustersTable;
