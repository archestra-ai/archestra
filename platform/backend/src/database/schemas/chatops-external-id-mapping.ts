import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import usersTable from "./user";

const chatopsExternalIdMappingTable = pgTable(
  "chatops_external_id_mapping",
  {
    id: text("id").primaryKey(),
    adapterId: text("adapter_id").notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("adapter_id_external_id_idx").on(
      table.adapterId,
      table.externalId,
    ),
  ],
);

export default chatopsExternalIdMappingTable;
