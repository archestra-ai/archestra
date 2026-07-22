import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import usersTable from "./user";

/**
 * Onboarding nav items (red-dot nudges) a user has already visited. Items are
 * opaque string keys (e.g. "nav:projects") so new dot targets — including
 * future in-page element dots — need no schema change. Per-user and
 * org-independent: the nav is the same everywhere, and a dot dismissed once
 * should stay dismissed.
 */
const userOnboardingSeenItemsTable = pgTable(
  "user_onboarding_seen_items",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    item: text("item").notNull(),
    seenAt: timestamp("seen_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.item] })],
);

export default userOnboardingSeenItemsTable;
