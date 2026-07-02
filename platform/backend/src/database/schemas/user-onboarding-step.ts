import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import usersTable from "./user";

/**
 * Per-user onboarding progress: one row per onboarding step a user has
 * completed ("hit") — a visited menu item. Absence of a row means the dot is
 * still shown, so new users naturally start with every dot visible.
 */
const userOnboardingStepsTable = pgTable(
  "user_onboarding_steps",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    completedAt: timestamp("completed_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.stepKey] })],
);

export default userOnboardingStepsTable;
