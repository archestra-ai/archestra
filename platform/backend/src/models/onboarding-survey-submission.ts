import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Per-org marker recording that the one-time onboarding survey was submitted.
 * Answers live in the archestra-website API; this only enforces "show once".
 */
class OnboardingSurveySubmissionModel {
  /** Whether this org has already submitted the survey. */
  static async hasSubmitted(organizationId: string): Promise<boolean> {
    const [row] = await db
      .select({
        organizationId: schema.onboardingSurveySubmissionsTable.organizationId,
      })
      .from(schema.onboardingSurveySubmissionsTable)
      .where(
        eq(
          schema.onboardingSurveySubmissionsTable.organizationId,
          organizationId,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Record the org's submission. Idempotent — the first submission wins. */
  static async record(params: {
    organizationId: string;
    submittedByUserId: string;
  }): Promise<void> {
    await db
      .insert(schema.onboardingSurveySubmissionsTable)
      .values({
        organizationId: params.organizationId,
        submittedByUserId: params.submittedByUserId,
      })
      .onConflictDoNothing();
  }
}

export default OnboardingSurveySubmissionModel;
