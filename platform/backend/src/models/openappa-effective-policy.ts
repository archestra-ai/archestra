import { and, eq } from "drizzle-orm";
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
   * Store a composition computed against `expected`, the row as it was read
   * before composing (null when there was none). Returns null when another
   * composition landed in between, so the caller recomposes from fresh inputs
   * instead of overwriting a newer document with a stale one.
   */
  static async save(params: {
    organizationId: string;
    values: EffectivePolicyValues;
    expected: EffectivePolicy | null;
  }): Promise<EffectivePolicy | null> {
    const { organizationId, values, expected } = params;
    const { error, ...composed } = values;
    const now = new Date();
    const row = {
      ...composed,
      compiledAt: now,
      lastError: error,
      lastErrorAt: error === null ? null : now,
    };
    if (expected === null) {
      const [inserted] = await db
        .insert(table)
        .values({ organizationId, ...row })
        .onConflictDoNothing()
        .returning();
      return inserted ?? null;
    }
    const [updated] = await db
      .update(table)
      .set(row)
      .where(
        and(
          eq(table.organizationId, organizationId),
          eq(table.compiledAt, expected.compiledAt),
          eq(table.rootRevision, expected.rootRevision),
          eq(table.installFingerprint, expected.installFingerprint),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /** Mark the stored row as needing recomposition: the next read recomposes before serving. */
  static async invalidate(organizationId: string): Promise<void> {
    await db
      .update(table)
      .set({ rootRevision: STALE_ROOT_REVISION })
      .where(eq(table.organizationId, organizationId));
  }
}

/** No root revision is negative, so a row marked with this never matches the current root. */
const STALE_ROOT_REVISION = -1;

export default OpenAppaEffectivePolicyModel;
