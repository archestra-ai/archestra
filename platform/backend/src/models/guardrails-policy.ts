import { desc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { guardrailsPolicyRevisionsTable as table } from "@/database/schemas/guardrails-policy";
import type { GuardrailsPolicy } from "@/types/guardrails-policy";

class GuardrailsPolicyModel {
  static async findLatest(organizationId: string) {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId))
      .orderBy(desc(table.revision))
      .limit(1);
    return row ?? null;
  }

  static async save(params: {
    organizationId: string;
    content: string;
    contentHash: string;
    updatedBy: string;
    expectedRevision: number;
  }): Promise<GuardrailsPolicy | null> {
    return db.transaction(async (tx) => {
      // Serialize the initial insert too: there is no policy row to lock yet.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${params.organizationId}`}, 0))`,
      );
      const [source] = await tx
        .select()
        .from(schema.openappaGithubSyncTable)
        .where(
          eq(
            schema.openappaGithubSyncTable.organizationId,
            params.organizationId,
          ),
        );
      if (source?.interval) return null;
      const [current] = await tx
        .select()
        .from(table)
        .where(eq(table.organizationId, params.organizationId))
        .orderBy(desc(table.revision))
        .limit(1);
      if ((current?.revision ?? 0) !== params.expectedRevision) return null;
      const { expectedRevision, ...values } = params;
      const [saved] = await tx
        .insert(table)
        .values({ ...values, revision: expectedRevision + 1 })
        .returning();
      return saved;
    });
  }

  static async findByIdForAudit(
    _id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await GuardrailsPolicyModel.findLatest(organizationId);
    return row
      ? {
          id: organizationId,
          name: "organization.appa.toml",
          revision: row.revision,
          contentHash: row.contentHash,
          updatedBy: row.updatedBy,
        }
      : null;
  }
}
export default GuardrailsPolicyModel;
