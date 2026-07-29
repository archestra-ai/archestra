// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import ContentEncryptionStateModel from "@/models/content-encryption-state.ee";
import { remintContentCanaryForCurrentKey } from "./guard.ee";
import {
  type ContentEncryptionContext,
  contentKeyFingerprint,
  decryptContentValue,
  encryptContentValue,
  isContentEncryptionEnabled,
  isContentEnvelope,
  isContentUnderPreviousKey,
} from "./index.ee";

type BackfillRunResult = {
  status: "disabled" | "deferred" | "in_progress" | "completed";
  rowsRewritten: number;
};

/**
 * Batched, resumable sweep that brings stored content in line with the
 * CURRENT content key: plaintext rows are encrypted, previous-key rows are
 * re-encrypted (rotation). Runs as a periodic cluster-singleton task and as
 * the operator-run `db:reencrypt-content` script; every batch is idempotent
 * and every row rewrite is compare-and-swap against the exact stored value,
 * so a concurrent live edit (already under the current key) can never be
 * clobbered by a stale sweep value — the CAS misses and the row is simply
 * skipped (it no longer needs backfilling).
 *
 * `maxBatchesPerRun` bounds one invocation; the periodic task picks the
 * cursor back up on its next tick. Completed state keyed by the current key's
 * fingerprint makes steady-state runs O(1); a rotation changes the
 * fingerprint and restarts the sweep.
 */
export async function runContentEncryptionBackfill(params: {
  batchSize?: number;
  maxBatchesPerRun?: number;
}): Promise<BackfillRunResult> {
  if (!isContentEncryptionEnabled()) {
    return { status: "disabled", rowsRewritten: 0 };
  }

  // Never rewrite messages while the content trigram index is still live —
  // the drop is fired at worker boot (index-maintenance), but it swallows
  // failures by design, so verify here and defer instead of paying GIN
  // maintenance on ciphertext.
  if (await messagesContentTrgmIndexExists()) {
    logger.warn(
      "content encryption backfill deferred: messages_content_trgm_idx still exists",
    );
    return { status: "deferred", rowsRewritten: 0 };
  }

  const state = await ContentEncryptionStateModel.ensureForFingerprint(
    contentKeyFingerprint(),
  );
  if (state.completedAt) {
    return { status: "completed", rowsRewritten: 0 };
  }

  const batchSize = params.batchSize ?? 500;
  let batchBudget = params.maxBatchesPerRun ?? 20;
  let rowsRewritten = 0;

  let interactionsCursor =
    state.interactionsCursorCreatedAt && state.interactionsCursorId
      ? {
          createdAt: state.interactionsCursorCreatedAt,
          id: state.interactionsCursorId,
        }
      : null;
  let interactionsDone = false;
  while (batchBudget > 0 && !interactionsDone) {
    batchBudget--;
    const batch = await sweepInteractionsBatch(interactionsCursor, batchSize);
    rowsRewritten += batch.rewritten;
    if (batch.lastCursor) {
      interactionsCursor = batch.lastCursor;
      await ContentEncryptionStateModel.advanceInteractionsCursor(
        batch.lastCursor,
      );
    }
    interactionsDone = batch.exhausted;
  }

  let messagesCursorId = state.messagesCursorId;
  let messagesDone = false;
  while (batchBudget > 0 && interactionsDone && !messagesDone) {
    batchBudget--;
    const batch = await sweepMessagesBatch(messagesCursorId, batchSize);
    rowsRewritten += batch.rewritten;
    if (batch.lastId) {
      messagesCursorId = batch.lastId;
      await ContentEncryptionStateModel.advanceMessagesCursor(batch.lastId);
    }
    messagesDone = batch.exhausted;
  }

  if (interactionsDone && messagesDone) {
    // Every row now carries the current key — safe to advance the canary
    // (no-op outside a rotation).
    await remintContentCanaryForCurrentKey();
    await ContentEncryptionStateModel.markCompleted();
    logger.info({ rowsRewritten }, "content encryption backfill completed");
    return { status: "completed", rowsRewritten };
  }
  return { status: "in_progress", rowsRewritten };
}

// === Internal ===

const INTERACTION_COLUMNS: Array<{
  column: string;
  context: ContentEncryptionContext;
}> = [
  { column: "request", context: "interactions.request" },
  { column: "processed_request", context: "interactions.processed_request" },
  { column: "response", context: "interactions.response" },
  { column: "dual_llm_analyses", context: "interactions.dual_llm_analyses" },
  {
    column: "unsafe_context_boundary",
    context: "interactions.unsafe_context_boundary",
  },
];

/** A stored value the sweep must rewrite: plaintext, or under the old key. */
function rewriteFor(
  value: unknown,
  context: ContentEncryptionContext,
): unknown | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isContentEnvelope(value)) {
    return encryptContentValue(value, context);
  }
  if (isContentUnderPreviousKey(value, context)) {
    return encryptContentValue(decryptContentValue(value, context), context);
  }
  return undefined;
}

async function sweepInteractionsBatch(
  cursor: { createdAt: string; id: string } | null,
  batchSize: number,
): Promise<{
  rewritten: number;
  lastCursor: { createdAt: string; id: string } | null;
  exhausted: boolean;
}> {
  const cursorClause = cursor
    ? sql`WHERE (created_at, id) > (${cursor.createdAt}::timestamp, ${cursor.id}::uuid)`
    : sql``;
  const rows = await db.execute<{
    id: string;
    created_at: string;
    request: unknown;
    processed_request: unknown;
    response: unknown;
    dual_llm_analyses: unknown;
    unsafe_context_boundary: unknown;
  }>(sql`
    SELECT id, created_at::text AS created_at, request, processed_request,
           response, dual_llm_analyses, unsafe_context_boundary
    FROM ${schema.interactionsTable}
    ${cursorClause}
    ORDER BY created_at ASC, id ASC
    LIMIT ${batchSize}
  `);

  let rewritten = 0;
  for (const row of rows.rows) {
    const record = row as unknown as Record<string, unknown>;
    const assignments = [];
    const guards = [];
    for (const { column, context } of INTERACTION_COLUMNS) {
      const next = rewriteFor(record[column], context);
      if (next === undefined) continue;
      assignments.push(
        sql`${sql.raw(column)} = ${JSON.stringify(next)}::jsonb`,
      );
      guards.push(
        sql`${sql.raw(column)} = ${JSON.stringify(record[column])}::jsonb`,
      );
    }
    if (assignments.length === 0) continue;

    const result = await db.execute<{ updated: number }>(sql`
      WITH updated AS (
        UPDATE ${schema.interactionsTable}
        SET ${sql.join(assignments, sql`, `)}
        WHERE id = ${row.id}::uuid AND ${sql.join(guards, sql` AND `)}
        RETURNING 1
      )
      SELECT COUNT(*)::int AS updated FROM updated
    `);
    rewritten += Number(result.rows[0]?.updated ?? 0);
  }

  const last = rows.rows.at(-1);
  return {
    rewritten,
    lastCursor: last ? { createdAt: last.created_at, id: last.id } : null,
    exhausted: rows.rows.length < batchSize,
  };
}

async function sweepMessagesBatch(
  cursorId: string | null,
  batchSize: number,
): Promise<{ rewritten: number; lastId: string | null; exhausted: boolean }> {
  const cursorClause = cursorId ? sql`WHERE id > ${cursorId}::uuid` : sql``;
  const rows = await db.execute<{ id: string; content: unknown }>(sql`
    SELECT id, content
    FROM ${schema.messagesTable}
    ${cursorClause}
    ORDER BY id ASC
    LIMIT ${batchSize}
  `);

  let rewritten = 0;
  for (const row of rows.rows) {
    const next = rewriteFor(row.content, "messages.content");
    if (next === undefined) continue;

    const result = await db.execute<{ updated: number }>(sql`
      WITH updated AS (
        UPDATE ${schema.messagesTable}
        SET content = ${JSON.stringify(next)}::jsonb
        WHERE id = ${row.id}::uuid
          AND content = ${JSON.stringify(row.content)}::jsonb
        RETURNING 1
      )
      SELECT COUNT(*)::int AS updated FROM updated
    `);
    rewritten += Number(result.rows[0]?.updated ?? 0);
  }

  const last = rows.rows.at(-1);
  return {
    rewritten,
    lastId: last ? last.id : null,
    exhausted: rows.rows.length < batchSize,
  };
}

async function messagesContentTrgmIndexExists(): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('messages_content_trgm_idx') IS NOT NULL AS exists`,
  );
  return Boolean(result.rows[0]?.exists);
}
