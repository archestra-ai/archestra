import type { CostExportFormat, CostExportSchedule } from "@archestra/shared";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { CostExportRunStatus } from "@/types/cost-export";
import blobProvidersTable from "./blob-provider";
import organizationsTable from "./organization";

/**
 * A scheduled export of LLM cost and usage data to a blob provider.
 *
 * Each run writes one file per completed `schedule` period (an hour or a UTC
 * day) that has not been exported yet: `exported_through` is the end of the
 * last period written, so a missed tick (or a provider outage) catches up on
 * the next one instead of leaving a gap. `running_until` is a short lease so
 * the periodic task and a manual "run now" never write the same export at
 * once.
 */
const costExportsTable = pgTable(
  "cost_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    // RESTRICT: deleting a provider an export writes to is refused with a
    // clear error instead of silently disabling the export.
    blobProviderId: uuid("blob_provider_id")
      .notNull()
      .references(() => blobProvidersTable.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 256 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    format: varchar("format").$type<CostExportFormat>().notNull(),
    schedule: varchar("schedule").$type<CostExportSchedule>().notNull(),
    /** Key prefix inside the provider (after the provider's own prefix). */
    pathPrefix: varchar("path_prefix", { length: 512 }).notNull(),
    /** End of the last period written; the next period starts here. */
    exportedThrough: timestamp("exported_through", { mode: "date" }).notNull(),
    runningUntil: timestamp("running_until", { mode: "date" }),
    lastRunAt: timestamp("last_run_at", { mode: "date" }),
    lastRunStatus: varchar("last_run_status").$type<CostExportRunStatus>(),
    lastRunError: text("last_run_error"),
    /** Failed runs in a row; scheduled retries back off as it grows. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Full object key of the most recent file written. */
    lastObjectKey: text("last_object_key"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("cost_exports_organization_id_idx").on(table.organizationId),
    index("cost_exports_blob_provider_id_idx").on(table.blobProviderId),
  ],
);

export default costExportsTable;
