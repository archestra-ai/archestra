import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * When an admin last reset a user's limit usage. Default user limits have no
 * usage counter (spend is summed from interactions per window), so a reset is
 * recorded as a marker: usage counted against a default user limit only
 * includes spend after `resetAt`. Custom (`limits`) rows are reset by zeroing
 * their counters instead; the marker is written for them too so the roster can
 * show when the last reset happened.
 */
const userLimitUsageResetsTable = pgTable(
  "user_limit_usage_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    resetAt: timestamp("reset_at", { mode: "date" }).notNull(),
    resetByUserId: text("reset_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("user_limit_usage_resets_org_user_unique").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export default userLimitUsageResetsTable;
