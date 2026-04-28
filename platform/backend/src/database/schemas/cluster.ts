import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import secretTable from "./secret";

const clustersTable = pgTable(
  "cluster",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    namespace: text("namespace"),
    kubeconfigSecretId: uuid("kubeconfig_secret_id").references(
      () => secretTable.id,
      { onDelete: "set null" },
    ),
    loadFromCluster: boolean("load_from_cluster").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    isPersonalDefault: boolean("is_personal_default").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("cluster_single_default_idx")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
    uniqueIndex("cluster_single_personal_default_idx")
      .on(table.isPersonalDefault)
      .where(sql`${table.isPersonalDefault} = true`),
  ],
);

export { clustersTable };
export default clustersTable;
