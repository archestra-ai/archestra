import { and, eq, isNotNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import {
  type EffectivePolicy,
  type ServedComposition,
  ServedCompositionSchema,
} from "@/types/openappa-batteries";

const table = schema.openappaEffectivePoliciesTable;

export type EffectivePolicyValues = Pick<
  EffectivePolicy,
  "content" | "contentHash" | "rootRevision" | "installFingerprint" | "served"
> & { error: string | null };

class OpenAppaEffectivePolicyModel {
  static async find(organizationId: string): Promise<EffectivePolicy | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row ? read(row) : null;
  }

  /** What a helper consult needs to know about the composition the runtime enforces. */
  static async findServed(organizationId: string) {
    const [row] = await db
      .select({
        organizationId: table.organizationId,
        contentHash: table.contentHash,
        lastError: table.lastError,
        served: table.served,
      })
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row ? { ...row, served: readServed(row) } : null;
  }

  /**
   * The refused organization whose enforced composition names this install
   * id in its helper URLs, for a consult whose install row a refused plan
   * already deleted.
   */
  static async findServingInstall(installId: string) {
    const [row] = await db
      .select({
        organizationId: table.organizationId,
        contentHash: table.contentHash,
        lastError: table.lastError,
        served: table.served,
      })
      .from(table)
      .where(
        and(
          isNotNull(table.lastError),
          sql`${table.served} @> ${JSON.stringify({ batteries: [{ installId }] })}::jsonb`,
        ),
      )
      .limit(1);
    return row ? { ...row, served: readServed(row) } : null;
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
    /** The store's time, which the values' `served` record names as its composition time. */
    now: Date;
  }): Promise<EffectivePolicy | null> {
    const { organizationId, values, expected, now } = params;
    const { error, ...composed } = values;
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
      return inserted ? read(inserted) : null;
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
    return updated ? read(updated) : null;
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

/** Rows whose `served` value did not parse, so each is logged once. */
const unreadable = registerProcessLocalCache(new Set<string>());

/** A stored row with its records parsed. */
function read(
  row: Omit<EffectivePolicy, "served"> & { served: unknown },
): EffectivePolicy {
  return { ...row, served: readServed(row) };
}

/** A stored `served` record, or null when it is absent or not one this build reads. */
function readServed(row: {
  organizationId: string;
  contentHash: string;
  served: unknown;
}): ServedComposition | null {
  if (row.served === null || row.served === undefined) return null;
  const parsed = ServedCompositionSchema.safeParse(row.served);
  if (parsed.success) return parsed.data;
  const key = `${row.organizationId}:${row.contentHash}`;
  if (!unreadable.has(key)) {
    unreadable.add(key);
    logger.warn(
      { organizationId: row.organizationId },
      "OpenAPPA cannot read what an effective policy row says it serves; treating its provenance as unknown",
    );
  }
  return null;
}

export default OpenAppaEffectivePolicyModel;
