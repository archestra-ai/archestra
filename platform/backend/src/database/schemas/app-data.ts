import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import usersTable from "./user";

/**
 * The App Data Store: per-app persistent storage exposed to app HTML through
 * the `app_data_*` tools (`archestra.storage`). Modeled as key→document
 * partitions: rows with a `user_id` belong to that viewer's private partition
 * (`archestra.storage.user`), rows without one form the app-wide shared
 * partition (`archestra.storage.shared`). The JSONB `value` column is an
 * implementation detail behind that neutral API, so the backend can change
 * without touching the app-facing contract.
 */
const appDataTable = pgTable(
  "app_data",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    /** Partition owner; NULL = the app-wide shared partition. */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    /** Caller-chosen key, unique within a partition. */
    key: text("key").notNull(),
    // Arbitrary JSON document. Key length, value size, and per-partition entry
    // count are enforced in AppDataModel, not in DDL: the platform's model-only
    // DB access makes the model the single writer, and the caps are
    // configurable constants (see types/app.ts) that a hardcoded CHECK would
    // contradict.
    value: jsonb("value").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("app_data_app_id_user_id_idx").on(table.appId, table.userId),
    // one key per partition: SQL UNIQUE treats NULLs as distinct, so the
    // shared partition (user_id IS NULL) needs its own partial unique index
    uniqueIndex("app_data_shared_partition_key_idx")
      .on(table.appId, table.key)
      .where(sql`${table.userId} IS NULL`),
    uniqueIndex("app_data_user_partition_key_idx")
      .on(table.appId, table.userId, table.key)
      .where(sql`${table.userId} IS NOT NULL`),
  ],
);

export default appDataTable;
