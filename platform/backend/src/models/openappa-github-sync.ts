import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type {
  AppaGithubSource,
  HeldPullReason,
} from "@/types/openappa-github-sync";

/** The held pull emptied: a row carries either held bytes or none of them. */
const NO_HOLD = {
  heldContent: null,
  heldContentHash: null,
  heldSourceCommit: null,
  heldReasons: [] as HeldPullReason[],
};

const table = schema.openappaGithubSyncTable;

/**
 * Share the editor's lock: source changes, manual edits, imported revisions and
 * accepted holds serialize against one another.
 */
function lockPolicy(tx: Transaction, organizationId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails-policy:${organizationId}`}, 0))`,
  );
}

class OpenAppaGithubSyncModel {
  static async find(organizationId: string) {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row ?? null;
  }
  static async setDeclarationsPendingPublish(
    organizationId: string,
    value: boolean,
  ) {
    await db
      .update(table)
      .set({ declarationsPendingPublish: value })
      .where(eq(table.organizationId, organizationId));
  }
  static async save(organizationId: string, source: AppaGithubSource) {
    const values = {
      ...source,
      revision: randomUUID(),
      sourceCommit: null,
      lastSyncedAt: null,
      lastSyncError: null,
      // Held bytes belong to the source they came from.
      ...NO_HOLD,
    };
    await db.transaction(async (tx) => {
      await lockPolicy(tx, organizationId);
      await tx
        .insert(table)
        .values({ organizationId, ...values })
        .onConflictDoUpdate({ target: table.organizationId, set: values });
    });
  }
  /**
   * Change or stop the schedule. A held pull belongs to the schedule that
   * fetched it: changing that schedule hands the text back to its authors, so
   * the held bytes go rather than wait to land on a later manual edit.
   */
  static async setInterval(
    organizationId: string,
    interval: AppaGithubSource["interval"] | null,
  ) {
    await db.transaction(async (tx) => {
      await lockPolicy(tx, organizationId);
      await tx
        .update(table)
        .set({ interval, revision: randomUUID(), ...NO_HOLD })
        .where(eq(table.organizationId, organizationId));
    });
  }
  /**
   * Record a pull's outcome, answering whether it was still the pull this row
   * expected: a download that raced a source edit or a disconnect records
   * nothing, and its caller must not act as though it had.
   */
  static async finish(params: {
    organizationId: string;
    revision: string;
    outcome:
      | { error: string }
      | { content: string; contentHash: string; sourceCommit: string };
  }): Promise<boolean> {
    const { organizationId, revision, outcome } = params;
    return db.transaction(async (tx) => {
      await lockPolicy(tx, organizationId);
      const [source] = await tx
        .update(table)
        .set({
          ...("error" in outcome
            ? { lastSyncError: outcome.error }
            : {
                content: outcome.content,
                sourceCommit: outcome.sourceCommit,
                lastSyncError: null,
                // A pull that publishes supersedes whatever was held.
                ...NO_HOLD,
              }),
          lastSyncedAt: new Date(),
          // A writer that read this revision has had its turn; whatever else
          // read it is answering for a row that no longer exists.
          revision: randomUUID(),
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
      if (!source) return false;
      if ("error" in outcome) return true;
      const policies = schema.guardrailsPolicyRevisionsTable;
      const [current] = await tx
        .select()
        .from(policies)
        .where(eq(policies.organizationId, organizationId))
        .orderBy(desc(policies.revision))
        .limit(1);
      if (current?.contentHash === outcome.contentHash) return true;
      await tx.insert(policies).values({
        organizationId,
        revision: (current?.revision ?? 0) + 1,
        content: outcome.content,
        contentHash: outcome.contentHash,
        updatedBy: null,
      });
      return true;
    });
  }

  /**
   * Record a pull that was fetched but not published. Same optimistic rule as
   * `finish`: a download racing a source edit or a disconnect records nothing.
   */
  static async hold(params: {
    organizationId: string;
    revision: string;
    content: string;
    contentHash: string;
    sourceCommit: string;
    reasons: HeldPullReason[];
    error: string;
  }): Promise<boolean> {
    const { organizationId, revision, ...held } = params;
    return db.transaction(async (tx) => {
      await lockPolicy(tx, organizationId);
      const [row] = await tx
        .update(table)
        .set({
          heldContent: held.content,
          heldContentHash: held.contentHash,
          heldSourceCommit: held.sourceCommit,
          heldReasons: held.reasons,
          lastSyncError: held.error,
          lastSyncedAt: new Date(),
          revision: randomUUID(),
        })
        .where(
          and(
            eq(table.organizationId, organizationId),
            eq(table.revision, revision),
            isNotNull(table.interval),
          ),
        )
        .returning({ organizationId: table.organizationId });
      return row !== undefined;
    });
  }

  /**
   * Publish the held bytes as a new revision authored by the user accepting
   * them, and clear the hold and the pending flag. Held bytes never reach the
   * policy any other way, and `GuardrailsPolicyModel.save` refuses a write while
   * syncing is on, which is exactly when a pull can be held.
   */
  static async publishHeld(params: {
    organizationId: string;
    userId: string;
    /** The held bytes the accepting user saw; anything else is a newer pull. */
    heldContentHash: string;
  }): Promise<{ contentHash: string; sourceCommit: string } | null> {
    const { organizationId, userId } = params;
    return db.transaction(async (tx) => {
      await lockPolicy(tx, organizationId);
      const [row] = await tx
        .select()
        .from(table)
        .where(eq(table.organizationId, organizationId));
      // Syncing off means the text belongs to its authors again: bytes the
      // schedule fetched may not land on top of what they wrote since.
      if (!row?.interval) return null;
      if (!row.heldContent || !row.heldContentHash || !row.heldSourceCommit)
        return null;
      if (row.heldContentHash !== params.heldContentHash) return null;
      const policies = schema.guardrailsPolicyRevisionsTable;
      const [current] = await tx
        .select()
        .from(policies)
        .where(eq(policies.organizationId, organizationId))
        .orderBy(desc(policies.revision))
        .limit(1);
      if (current?.contentHash !== row.heldContentHash)
        await tx.insert(policies).values({
          organizationId,
          revision: (current?.revision ?? 0) + 1,
          content: row.heldContent,
          contentHash: row.heldContentHash,
          updatedBy: userId,
        });
      await tx
        .update(table)
        .set({
          content: row.heldContent,
          sourceCommit: row.heldSourceCommit,
          lastSyncError: null,
          declarationsPendingPublish: false,
          revision: randomUUID(),
          ...NO_HOLD,
        })
        .where(eq(table.organizationId, organizationId));
      return {
        contentHash: row.heldContentHash,
        sourceCommit: row.heldSourceCommit,
      };
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
    const { content, heldContent, ...metadata } = row;
    return {
      ...metadata,
      hasPolicy: content !== null,
      hasHeldPull: heldContent !== null,
    };
  }
}
export default OpenAppaGithubSyncModel;
