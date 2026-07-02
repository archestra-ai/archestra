import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * Per-org marker that the one-time onboarding survey has been submitted. The
 * survey answers themselves are NOT stored here — they're forwarded to the
 * archestra-website API. This table only records that an org answered (one row
 * per org), so the form is shown once and never again.
 */
const onboardingSurveySubmissionsTable = pgTable(
  "onboarding_survey_submissions",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** Admin who submitted; kept for context, nulled on user delete. */
    submittedByUserId: text("submitted_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
);

export default onboardingSurveySubmissionsTable;
