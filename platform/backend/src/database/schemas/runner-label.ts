import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import labelKeysTable from "./label-key";
import labelValuesTable from "./label-value";
import runnersTable from "./runner";

/**
 * Labels on a runner, sharing the organization-wide key/value vocabulary with
 * agents, apps and MCP catalog entries so one filter language covers them all.
 */
const runnerLabelsTable = pgTable(
  "runner_labels",
  {
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runnersTable.id, { onDelete: "cascade" }),
    labelKeyId: uuid("label_key_id")
      .notNull()
      .references(() => labelKeysTable.id, { onDelete: "cascade" }),
    labelValueId: uuid("label_value_id")
      .notNull()
      .references(() => labelValuesTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.labelKeyId] }),
    index("runner_labels_label_value_id_idx").on(table.labelValueId),
  ],
);

export default runnerLabelsTable;
