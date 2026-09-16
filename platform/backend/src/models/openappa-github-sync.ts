import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AppaGithubSource } from "@/types/openappa-github-sync";

const table = schema.openappaGithubSyncTable;
class OpenAppaGithubSyncModel {
  static async find(organizationId: string) {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row ?? null;
  }
  static async save(organizationId: string, source: AppaGithubSource) {
    const values = {
      ...source,
      revision: randomUUID(),
      sourceCommit: null,
      lastSyncedAt: null,
      lastSyncError: null,
    };
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${organizationId}`}, 0))`,
      );
      await tx
        .insert(table)
        .values({ organizationId, ...values })
        .onConflictDoUpdate({ target: table.organizationId, set: values });
    });
  }
  static async setInterval(
    organizationId: string,
    interval: AppaGithubSource["interval"] | null,
  ) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${organizationId}`}, 0))`,
      );
      await tx
        .update(table)
        .set({ interval, revision: randomUUID() })
        .where(eq(table.organizationId, organizationId));
    });
  }
  static async finish(params: {
    organizationId: string;
    revision: string;
    outcome:
      | { error: string }
      | { content: string; contentHash: string; sourceCommit: string };
  }) {
    const { organizationId, revision, outcome } = params;
    await db.transaction(async (tx) => {
      // Share the editor's lock: source changes, manual edits and imported revisions serialize.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${organizationId}`}, 0))`,
      );
      const [source] = await tx
        .update(table)
        .set({
          ...("error" in outcome
            ? { lastSyncError: outcome.error }
            : {
                content: outcome.content,
                sourceCommit: outcome.sourceCommit,
                lastSyncError: null,
              }),
          lastSyncedAt: new Date(),
        })
        .where(
          and(
            eq(table.organizationId, organizationId),
            eq(table.revision, revision),
            isNotNull(table.interval),
          ),
        )
        .returning();
      // A download racing a source edit or disconnect must not publish a policy revision.
      if (!source || "error" in outcome) return;
      const policies = schema.guardrailsPolicyRevisionsTable;
      const [current] = await tx
        .select()
        .from(policies)
        .where(eq(policies.organizationId, organizationId))
        .orderBy(desc(policies.revision))
        .limit(1);
      if (current?.contentHash === outcome.contentHash) return;
      await tx.insert(policies).values({
        organizationId,
        revision: (current?.revision ?? 0) + 1,
        content: outcome.content,
        contentHash: outcome.contentHash,
        updatedBy: null,
      });
    });
  }

  static async findDue() {
    return db
      .select()
      .from(table)
      .where(
        and(
          isNotNull(table.interval),
          sql`(${table.lastSyncedAt} IS NULL OR ${table.lastSyncedAt} <= NOW() - CASE ${table.interval} WHEN '15m' THEN INTERVAL '15 minutes' WHEN '1h' THEN INTERVAL '1 hour' ELSE INTERVAL '1 day' END)`,
        ),
      );
  }
  static async enqueue(organizationId: string) {
    // The partial unique index also deduplicates simultaneous requests on different replicas.
    await db
      .insert(schema.tasksTable)
      .values({
        taskType: "openappa_github_sync",
        payload: { organizationId },
        maxAttempts: 1,
      })
      .onConflictDoNothing();
  }
  static async findByIdForAudit(id: string, organizationId: string) {
    if (id !== organizationId) return null;
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    if (!row) return null;
    const { content, ...metadata } = row;
    return { ...metadata, hasPolicy: content !== null };
  }
}
export default OpenAppaGithubSyncModel;
