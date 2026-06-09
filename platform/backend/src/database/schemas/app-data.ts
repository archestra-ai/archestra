import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";

/**
 * The App Data Store: per-app persistent storage exposed to app HTML through
 * the `app_data_*` tools (`window.archestra.data`). Modeled as a key→document
 * map; the JSONB `value` column is an implementation detail behind that neutral
 * API, so the backend can change without touching the app-facing contract.
 */
const appDataTable = pgTable(
  "app_data",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    /** Caller-chosen key, unique within an app. */
    key: text("key").notNull(),
    // Arbitrary JSON document. Key length, value size, and per-app entry count
    // are enforced in AppDataModel, not in DDL: the platform's model-only DB
    // access makes the model the single writer, and the caps are configurable
    // constants (see types/app.ts) that a hardcoded CHECK would contradict.
    value: jsonb("value").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("app_data_app_id_idx").on(table.appId),
    unique().on(table.appId, table.key),
  ],
);

export default appDataTable;
