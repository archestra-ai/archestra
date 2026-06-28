import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import usersTable from "./user";

// drizzle's built-in jsonb() re-parses any string the driver returns, but pg
// and PGlite already hand jsonb back parsed — so a stored JSON-string value
// ('"42"', '"{\"x\":1}"') would be parsed a second time and come back as a
// number/object. The store's contract is identity round-trip for any JSON
// value, so map the driver value through untouched.
const faithfulJsonb = customType<{ data: unknown; driverParam: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value;
  },
});

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
    // Monotonic per-entry version for optimistic concurrency: every successful
    // write bumps it (new row → 1, update → current+1). Callers opt into
    // compare-and-set by passing an expectedRevision; omitting it keeps the
    // last-writer-wins default. Enforced in AppDataModel under the app-row lock.
    revision: integer("revision").notNull().default(1),
    // Optional owner of a SHARED-partition key (user_id IS NULL). When set, only
    // the owner — or a caller the model is told may override — may overwrite or
    // delete the key. NULL means collaborative (anyone with access may write),
    // which is the pre-ownership default. User-partition keys are already
    // private, so this is unused there. Owner-deletion is decoupled from the
    // entry's lifetime: set null so an owned shared key survives the owner's
    // departure as a collaborative key rather than vanishing.
    ownerUserId: text("owner_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    // Arbitrary JSON document. Key length, value size, and per-partition entry
    // count are enforced in AppDataModel, not in DDL: the platform's model-only
    // DB access makes the model the single writer, and the caps are
    // configurable constants (see types/app.ts) that a hardcoded CHECK would
    // contradict.
    value: faithfulJsonb("value").notNull(),
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
