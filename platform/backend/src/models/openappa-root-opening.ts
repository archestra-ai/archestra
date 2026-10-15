import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";

const table = schema.openappaRootOpeningsTable;
const operations = schema.openappaOperationsTable;

/**
 * Which opening policy each runtime root opened under, and which of those
 * policies a conversation was active under lately. A root's opening never
 * changes, so its row is written once, the first time it is asked about.
 *
 * Activity is the runtime's operation receipts: every hook event a
 * conversation sends leaves one, and the host never prunes them. A dispatch
 * that fails before the runtime records anything leaves none.
 */
class OpenAppaRootOpeningModel {
  /** Roots with an operation since `since` whose opening is not recorded yet. */
  static async unresolvedRoots(params: {
    organizationId: string;
    since: Date;
  }): Promise<string[]> {
    const rows = await db
      .selectDistinct({ root: operations.root })
      .from(operations)
      .leftJoin(table, eq(table.root, operations.root))
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          gte(operations.createdAt, params.since),
          isNull(table.root),
        ),
      );
    return rows.map((row) => row.root);
  }

  /** Record roots' openings; a root already recorded keeps its row. */
  static async record(params: {
    organizationId: string;
    openings: readonly { root: string; policyFileKey: string }[];
  }): Promise<void> {
    if (params.openings.length === 0) return;
    await db
      .insert(table)
      .values(
        params.openings.map(({ root, policyFileKey }) => ({
          root,
          policyFileKey,
          organizationId: params.organizationId,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * For each of `keys` a conversation opened under, the conversations with an
   * operation since `since` and the latest one's time. Keys with none are left out.
   */
  static async activityByOpening(params: {
    organizationId: string;
    since: Date;
    keys: readonly string[];
  }): Promise<Map<string, { liveRoots: number; lastActivityAt: Date }>> {
    if (params.keys.length === 0) return new Map();
    const rows = await db
      .select({
        key: table.policyFileKey,
        liveRoots: sql<number>`count(distinct ${operations.root})::int`,
        lastActivityAt: sql<Date>`max(${operations.createdAt})`,
      })
      .from(operations)
      .innerJoin(table, eq(table.root, operations.root))
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          gte(operations.createdAt, params.since),
          inArray(table.policyFileKey, [...params.keys]),
        ),
      )
      .groupBy(table.policyFileKey);
    return new Map(
      rows.map(({ key, liveRoots, lastActivityAt }) => [
        key,
        { liveRoots, lastActivityAt: new Date(lastActivityAt) },
      ]),
    );
  }
}

export default OpenAppaRootOpeningModel;
