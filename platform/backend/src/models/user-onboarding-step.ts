import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Per-user onboarding progress. Reads and writes are always scoped to a single
 * user; a "completed" step is a menu item the user has visited.
 */
class UserOnboardingStepModel {
  /** Record a step as completed for a user; idempotent (re-hit is a no-op). */
  static async markCompleted(params: {
    userId: string;
    stepKey: string;
  }): Promise<void> {
    await db
      .insert(schema.userOnboardingStepsTable)
      .values({ userId: params.userId, stepKey: params.stepKey })
      .onConflictDoNothing();
  }

  /** All step keys this user has completed. */
  static async listCompletedKeys(params: {
    userId: string;
  }): Promise<string[]> {
    const rows = await db
      .select({ stepKey: schema.userOnboardingStepsTable.stepKey })
      .from(schema.userOnboardingStepsTable)
      .where(eq(schema.userOnboardingStepsTable.userId, params.userId));
    return rows.map((r) => r.stepKey);
  }
}

export default UserOnboardingStepModel;
