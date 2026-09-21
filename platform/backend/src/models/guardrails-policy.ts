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
      await lockPolicy(tx, params.organizationId);
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
      const { expectedRevision, ...values } = params;
      return insertRevision(tx, { ...values, expectedRevision });
    });
  }

  /**
   * Insert the revision the install-declaration migration authors, with no user
   * behind it. Same advisory lock and same `expectedRevision` check as `save`,
   * and unlike `save` it writes while the organization's GitHub sync is on: the
   * declarations it carries are the legacy install rows, which the repository
   * text does not hold yet and which the first recompose after the deploy would
   * otherwise delete. It is the migration's own path — every user-driven write
   * goes through `guardrailsPolicyService.update`, which authorizes the grants
   * it adds; this one authors none that the install rows did not already serve.
   */
  static async saveDeclarationMigration(params: {
    organizationId: string;
    content: string;
    contentHash: string;
    expectedRevision: number;
  }): Promise<GuardrailsPolicy | null> {
    return db.transaction(async (tx) => {
      await lockPolicy(tx, params.organizationId);
      return insertRevision(tx, { ...params, updatedBy: null });
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

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize the initial insert too: there is no policy row to lock yet. */
async function lockPolicy(tx: Transaction, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${organizationId}`}, 0))`,
  );
}

/** The revision after `expectedRevision`, or nothing when that race was lost. */
async function insertRevision(
  tx: Transaction,
  values: {
    organizationId: string;
    content: string;
    contentHash: string;
    updatedBy: string | null;
    expectedRevision: number;
  },
): Promise<GuardrailsPolicy | null> {
  const { expectedRevision, ...revision } = values;
  const [current] = await tx
    .select()
    .from(table)
    .where(eq(table.organizationId, values.organizationId))
    .orderBy(desc(table.revision))
    .limit(1);
  if ((current?.revision ?? 0) !== expectedRevision) return null;
  const [saved] = await tx
    .insert(table)
    .values({ ...revision, revision: expectedRevision + 1 })
    .returning();
  return saved;
}
