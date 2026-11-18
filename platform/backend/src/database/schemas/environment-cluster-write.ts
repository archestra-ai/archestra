import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import environmentsTable from "./environment";

/**
 * Operations that are creating or changing workloads in the Kubernetes
 * cluster of an environment that deploys into a cluster of its own.
 *
 * An operation adds its row before its first effect and removes it when it
 * has ended. An environment cannot be marked as being deleted while it has a
 * recent row here, and a row cannot be added for a marked environment, so the
 * cleanup of the cluster that precedes the delete works on a cluster no
 * operation is still writing to. A row left behind by a process that stopped
 * is ignored once it is old.
 */
const environmentClusterWritesTable = pgTable(
  "environment_cluster_writes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environmentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("environment_cluster_writes_environment_id_idx").on(
      table.environmentId,
    ),
  ],
);

export default environmentClusterWritesTable;
