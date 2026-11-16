import type { PaginationQuery } from "@archestra/shared";
import { and, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  TunerCandidate,
  TunerFingerprint,
  TunerKind,
  TunerSuggestedAction,
  TunerSuggestionStatus,
} from "@/types/tuner";
import type { TunerSuggestion } from "@/types/tuner-suggestion";
import {
  EMPTY_FINGERPRINT_HISTORY,
  type FingerprintHistory,
  isClosedByAdmin,
  type SuppressionReason,
  suppressionVerdict,
} from "@/utils/tuner-suppression";

const table = schema.tunerSuggestionsTable;

export type ProposeResult =
  | { type: "created"; suggestion: TunerSuggestion }
  | { type: "suppressed"; reason: SuppressionReason };

/**
 * Every status change runs in a transaction holding the fingerprint's advisory
 * lock and updates only from the expected status, so a scheduled run and an
 * admin acting on the same fingerprint serialize and the loser sees `null`.
 */
class TunerSuggestionModel {
  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<TunerSuggestion | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return TunerSuggestionModel.findById({ id, organizationId });
  }

  static async list(params: {
    organizationId: string;
    tunerKind?: TunerKind;
    statuses?: TunerSuggestionStatus[];
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<TunerSuggestion>> {
    const where = and(
      eq(table.organizationId, params.organizationId),
      params.tunerKind ? eq(table.tunerKind, params.tunerKind) : undefined,
      params.statuses?.length
        ? inArray(table.status, params.statuses)
        : undefined,
    );
    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(table)
        .where(where)
        .orderBy(desc(table.createdAt), desc(table.id))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db.select({ total: count() }).from(table).where(where),
    ]);
    return createPaginatedResult(data, Number(total), params.pagination);
  }

  /** History of each fingerprint, for suppression decisions outside a lock. */
  static async historyByFingerprint(params: {
    organizationId: string;
    fingerprints: TunerFingerprint[];
  }): Promise<Map<TunerFingerprint, FingerprintHistory>> {
    return historyByFingerprint(db, params);
  }

  /** The latest `perFingerprint` suggestions of each fingerprint, newest first. */
  static async recentByFingerprint(params: {
    organizationId: string;
    fingerprints: TunerFingerprint[];
    perFingerprint: number;
  }): Promise<TunerSuggestion[]> {
    if (params.fingerprints.length === 0) return [];
    const ranked = db
      .select({
        id: table.id,
        rank: sql<number>`row_number() over (partition by ${table.fingerprint} order by ${table.createdAt} desc)`.as(
          "rank",
        ),
      })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          inArray(table.fingerprint, params.fingerprints),
        ),
      )
      .as("ranked");
    const rows = await db
      .select({ suggestion: table })
      .from(table)
      .innerJoin(ranked, eq(ranked.id, table.id))
      .where(sql`${ranked.rank} <= ${params.perFingerprint}`)
      .orderBy(table.fingerprint, desc(table.createdAt));
    return rows.map((row) => row.suggestion);
  }

  static async findPublishedPolicyChanges(
    organizationId: string,
  ): Promise<TunerSuggestion[]> {
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, organizationId),
          eq(table.status, "published"),
          sql`${table.action}->>'type' = 'policy_change'`,
        ),
      );
  }

  /**
   * Files a suggestion for a candidate unless the fingerprint's history
   * suppresses it; a higher-severity candidate supersedes the open one.
   */
  static async propose(params: {
    organizationId: string;
    tunerKind: TunerKind;
    candidate: TunerCandidate;
    rationale: string;
    action: TunerSuggestedAction;
    scheduleTriggerRunId: string;
    now: Date;
  }): Promise<ProposeResult> {
    const { organizationId, candidate } = params;
    return db.transaction(async (tx) => {
      await lockFingerprint(tx, organizationId, candidate.fingerprint);
      const history =
        (
          await historyByFingerprint(tx, {
            organizationId,
            fingerprints: [candidate.fingerprint],
          })
        ).get(candidate.fingerprint) ?? EMPTY_FINGERPRINT_HISTORY;
      const verdict = suppressionVerdict(
        history,
        candidate.severity,
        params.now,
      );
      switch (verdict.type) {
        case "suppressed":
          return verdict;
        case "supersede":
          await tx
            .update(table)
            .set({
              status: "resolved",
              statusChangedAt: params.now,
              statusChangedBy: null,
            })
            .where(
              and(eq(table.id, verdict.activeId), eq(table.status, "open")),
            );
          break;
        case "new":
          break;
      }
      const [suggestion] = await tx
        .insert(table)
        .values({
          organizationId,
          tunerKind: params.tunerKind,
          fingerprint: candidate.fingerprint,
          source: candidate.source,
          severity: candidate.severity,
          title: candidate.title,
          rationale: params.rationale,
          evidence: candidate.evidence,
          action: params.action,
          status: "open",
          statusChangedAt: params.now,
          scheduleTriggerRunId: params.scheduleTriggerRunId,
        })
        .returning();
      return { type: "created", suggestion };
    });
  }

  /** An admin closes an open suggestion; `null` when it is no longer open. */
  static async close(params: {
    id: string;
    organizationId: string;
    userId: string;
    status: "done" | "rejected";
    comment: string | null;
  }): Promise<TunerSuggestion | null> {
    return transition({
      id: params.id,
      organizationId: params.organizationId,
      from: "open",
      set: {
        status: params.status,
        statusChangedBy: params.userId,
        comment: params.comment,
      },
    });
  }

  /** Claims an open policy change for applying; `null` when someone else did. */
  static async claimForApply(params: {
    id: string;
    organizationId: string;
    userId: string;
  }): Promise<TunerSuggestion | null> {
    return transition({
      id: params.id,
      organizationId: params.organizationId,
      from: "open",
      set: { status: "published", statusChangedBy: params.userId },
    });
  }

  /** Returns a claimed suggestion to `open` after its apply failed. */
  static async releaseClaim(params: {
    id: string;
    organizationId: string;
  }): Promise<TunerSuggestion | null> {
    return transition({
      id: params.id,
      organizationId: params.organizationId,
      from: "published",
      set: { status: "open", statusChangedBy: null },
    });
  }

  static async recordPublication(params: {
    id: string;
    organizationId: string;
    action: TunerSuggestedAction;
  }): Promise<TunerSuggestion | null> {
    const [row] = await db
      .update(table)
      .set({ action: params.action })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          eq(table.status, "published"),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async markEffective(params: {
    id: string;
    organizationId: string;
    userId: string | null;
  }): Promise<TunerSuggestion | null> {
    return transition({
      id: params.id,
      organizationId: params.organizationId,
      from: "published",
      set: { status: "effective", statusChangedBy: params.userId },
    });
  }

  /**
   * Resolves the tuner's open suggestions whose fingerprint is no longer a
   * candidate. Closed suggestions are never touched.
   */
  static async resolveVanished(params: {
    organizationId: string;
    tunerKind: TunerKind;
    present: TunerFingerprint[];
    now: Date;
  }): Promise<number> {
    const vanished = await db
      .select({ id: table.id, fingerprint: table.fingerprint })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.tunerKind, params.tunerKind),
          eq(table.status, "open"),
          params.present.length
            ? notInArray(table.fingerprint, params.present)
            : undefined,
        ),
      )
      .orderBy(table.fingerprint);
    let resolved = 0;
    for (const row of vanished) {
      const updated = await transition({
        id: row.id,
        organizationId: params.organizationId,
        from: "open",
        set: { status: "resolved", statusChangedBy: null },
        now: params.now,
      });
      if (updated) resolved += 1;
    }
    return resolved;
  }
}

export default TunerSuggestionModel;

async function lockFingerprint(
  tx: Transaction,
  organizationId: string,
  fingerprint: TunerFingerprint,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tuner-suggestion:${organizationId}:${fingerprint}`}, 0))`,
  );
}

async function transition(params: {
  id: string;
  organizationId: string;
  from: TunerSuggestionStatus;
  set: {
    status: TunerSuggestionStatus;
    statusChangedBy: string | null;
    comment?: string | null;
  };
  now?: Date;
}): Promise<TunerSuggestion | null> {
  const [target] = await db
    .select({ fingerprint: table.fingerprint })
    .from(table)
    .where(
      and(
        eq(table.id, params.id),
        eq(table.organizationId, params.organizationId),
      ),
    );
  if (!target) return null;
  return db.transaction(async (tx) => {
    await lockFingerprint(tx, params.organizationId, target.fingerprint);
    const [row] = await tx
      .update(table)
      .set({ ...params.set, statusChangedAt: params.now ?? new Date() })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          eq(table.status, params.from),
        ),
      )
      .returning();
    return row ?? null;
  });
}

async function historyByFingerprint(
  executor: Transaction | typeof db,
  params: { organizationId: string; fingerprints: TunerFingerprint[] },
): Promise<Map<TunerFingerprint, FingerprintHistory>> {
  const result = new Map<TunerFingerprint, FingerprintHistory>();
  if (params.fingerprints.length === 0) return result;
  const rows = await executor
    .select({
      id: table.id,
      fingerprint: table.fingerprint,
      status: table.status,
      severity: table.severity,
      statusChangedAt: table.statusChangedAt,
    })
    .from(table)
    .where(
      and(
        eq(table.organizationId, params.organizationId),
        inArray(table.fingerprint, params.fingerprints),
        inArray(table.status, ["open", "published", "done", "rejected"]),
      ),
    )
    .orderBy(desc(table.statusChangedAt));
  for (const row of rows) {
    const history = result.get(row.fingerprint) ?? {
      ...EMPTY_FINGERPRINT_HISTORY,
    };
    if (
      (row.status === "open" || row.status === "published") &&
      !history.active
    ) {
      history.active = {
        id: row.id,
        status: row.status,
        severity: row.severity,
      };
    } else if (isClosedByAdmin(row.status) && !history.lastClosed) {
      history.lastClosed = {
        status: row.status,
        severity: row.severity,
        statusChangedAt: row.statusChangedAt,
      };
    }
    result.set(row.fingerprint, history);
  }
  return result;
}
