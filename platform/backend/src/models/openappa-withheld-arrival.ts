import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

const table = schema.openappaWithheldArrivalsTable;

/**
 * The messages between agents the proxy withheld from a session, by digest.
 * A message is withheld the first time it would reach the model unchecked,
 * and every later turn withholds it again. The proxy writes every row.
 */
class OpenAppaWithheldArrivalModel {
  /** The digests withheld from any of the sessions, such as a fork's line. */
  static async digests(params: {
    organizationId: string;
    sessionIds: readonly string[];
  }): Promise<Set<string>> {
    if (params.sessionIds.length === 0) return new Set();
    const rows = await db
      .select({ digest: table.digest })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          inArray(table.sessionId, [...params.sessionIds]),
        ),
      );
    return new Set(rows.map((row) => row.digest));
  }

  static async record(params: {
    organizationId: string;
    callerId?: string;
    sessionId: string;
    digests: readonly string[];
  }): Promise<void> {
    if (params.digests.length === 0) return;
    await db
      .insert(table)
      .values(
        params.digests.map((digest) => ({
          organizationId: params.organizationId,
          callerId: params.callerId ?? null,
          sessionId: params.sessionId,
          digest,
        })),
      )
      .onConflictDoNothing();
  }
}

export default OpenAppaWithheldArrivalModel;
