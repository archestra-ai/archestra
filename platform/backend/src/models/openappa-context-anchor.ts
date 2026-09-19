import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

const table = schema.openappaContextAnchorsTable;

/** Paragraph digests of the context each caller-scoped session's model wrote. */
class OpenAppaContextAnchorModel {
  static async record(params: {
    organizationId: string;
    callerId: string;
    sessionId: string;
    digests: readonly string[];
  }): Promise<void> {
    if (params.digests.length === 0) return;
    await db
      .insert(table)
      .values(
        params.digests.map((digest) => ({
          organizationId: params.organizationId,
          callerId: params.callerId,
          digest,
          sessionId: params.sessionId,
        })),
      )
      .onConflictDoNothing();
  }

  /** The sessions that wrote each of these digests, by digest. */
  static async sessionsFor(params: {
    organizationId: string;
    callerId: string;
    digests: readonly string[];
  }): Promise<Map<string, string[]>> {
    if (params.digests.length === 0) return new Map();
    const rows = await db
      .select({ digest: table.digest, sessionId: table.sessionId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.callerId, params.callerId),
          inArray(table.digest, [...params.digests]),
        ),
      );
    const owners = new Map<string, string[]>();
    for (const row of rows) {
      owners.set(row.digest, [
        ...(owners.get(row.digest) ?? []),
        row.sessionId,
      ]);
    }
    return owners;
  }
}

export default OpenAppaContextAnchorModel;
