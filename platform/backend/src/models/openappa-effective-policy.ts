import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { EffectivePolicy } from "@/types/openappa-batteries";

const table = schema.openappaEffectivePoliciesTable;

export type EffectivePolicyValues = Pick<
  EffectivePolicy,
  "content" | "contentHash" | "rootRevision" | "installFingerprint"
> & { error: string | null };

class OpenAppaEffectivePolicyModel {
  static async find(organizationId: string): Promise<EffectivePolicy | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row ?? null;
  }

  /**
   * Compose and store the organization's effective policy under the same advisory
   * lock root-policy edits and GitHub imports take, so one composition at a time
   * observes a settled root and install set.
   */
  static async recompile(
    organizationId: string,
    compose: () => Promise<EffectivePolicyValues>,
  ): Promise<EffectivePolicy> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${organizationId}`}, 0))`,
      );
      const { error, ...values } = await compose();
      const now = new Date();
      const [row] = await tx
        .insert(table)
        .values({
          organizationId,
          ...values,
          compiledAt: now,
          lastError: error,
          lastErrorAt: error === null ? null : now,
        })
        .onConflictDoUpdate({
          target: table.organizationId,
          set: {
            ...values,
            compiledAt: now,
            lastError: error,
            lastErrorAt: error === null ? null : now,
          },
        })
        .returning();
      return row;
    });
  }
}

export default OpenAppaEffectivePolicyModel;
