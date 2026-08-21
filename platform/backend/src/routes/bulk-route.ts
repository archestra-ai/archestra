import { MAX_BULK_IDS } from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { ApiError } from "@/types/api";

/**
 * The shape every `PATCH /api/<resource>/bulk` and `DELETE /api/<resource>/bulk`
 * route speaks, so a caller that has driven one has driven all of them.
 *
 * Two rules hold across the family:
 *
 * - **Ids go in the body**, on DELETE as much as on PATCH. A selection can run
 *   to hundreds of uuids, which is well past what a query string can carry.
 * - **Partial success is the normal outcome**, not an error. Ids are authorized
 *   one at a time, so a single row the caller may not touch is reported in
 *   `failed` and the rest of the batch still applies. A 4xx means the *request*
 *   was unusable — an empty list, too many ids, a target scope that exists
 *   nowhere — and in that case nothing was written at all.
 *
 * Request-level validation therefore has to happen before the loop starts:
 * anything that would fail identically for every id belongs in a 400, not in
 * N copies of the same message.
 */
export const BulkIdsSchema = z
  .array(z.string())
  .min(1)
  .max(MAX_BULK_IDS)
  .describe("Ids to act on. Duplicates are collapsed.");

/** Body of every bulk delete: the ids, and nothing else. */
export const BulkDeleteBodySchema = z.object({ ids: BulkIdsSchema });

export const BulkOutcomeSchema = z.object({
  succeeded: z.array(
    z.object({
      id: z.string(),
      /** What to call this row in a confirmation, in the caller's own terms. */
      name: z.string(),
    }),
  ),
  failed: z.array(
    z.object({
      id: z.string(),
      /** Null when the id resolved to nothing the caller can see. */
      name: z.string().nullable(),
      /** Shown to the person who asked, so it has to read as a reason. */
      error: z.string(),
    }),
  ),
});

export type BulkOutcome = z.infer<typeof BulkOutcomeSchema>;

type BulkEntry<TItem> = { id: string; item: TItem };

/**
 * Runs one bulk action over a batch of ids and reports what happened to each.
 *
 * The division of labour is deliberate. `load` decides what the caller is
 * allowed to *see* and must fence rows to their organization — ids arrive
 * straight from a request body, and several resources short-circuit their
 * permission checks for an admin, where "admin" means admin of the caller's
 * own organization. An id `load` omits is indistinguishable from one that never
 * existed, which is the same answer the single-item routes give. `authorize`
 * then decides what the caller may *do* to a row it can see, mirroring whatever
 * the single-item route checks.
 *
 * Writes come in two flavours because the resources do. `applyEach` suits a
 * write that can fail for one row and not another — a rename that collides, a
 * state transition the row is not in. `applyAll` suits one that cannot, and
 * spends one statement on the whole batch instead of N.
 *
 * An unexpected error inside `applyEach` is logged and reported against its own
 * row rather than rethrown: earlier rows in the batch have already been
 * written, and the audit hook drops `auditAfter` on a non-2xx, so letting it
 * escape would turn real mutations into a 500 with no record of them.
 */
export async function runBulk<TItem>({
  ids,
  load,
  describe,
  authorize,
  applyEach,
  applyAll,
  translateError,
  notFoundMessage,
  unexpectedMessage,
  logLabel,
  audit,
}: {
  ids: string[];
  /**
   * Every requested row the caller may see, keyed by id and fenced to their
   * organization. Ids missing from the map are reported as not found.
   */
  load: (ids: string[]) => Promise<Map<string, TItem>>;
  describe: (item: TItem) => string;
  /** Throw an `ApiError` to fail just this row. Anything else aborts the batch. */
  authorize?: (item: TItem, id: string) => void | Promise<void>;
  /** Write one row. Mutually exclusive with `applyAll`. */
  applyEach?: (item: TItem, id: string) => Promise<void>;
  /** Write every authorized row at once. Mutually exclusive with `applyEach`. */
  applyAll?: (entries: BulkEntry<TItem>[]) => Promise<void>;
  /**
   * Turns a resource-specific error into the reason shown for that row —
   * a name collision, a foreign key that says the row is still in use.
   * Return null to let the default handling take over.
   */
  translateError?: (error: unknown, item: TItem) => string | null;
  notFoundMessage: string;
  /** Reason recorded when a row fails for a reason nobody anticipated. */
  unexpectedMessage: string;
  /** Names this batch in the log when that happens. */
  logLabel: string;
  /**
   * Records what the batch changed. The generic `fetchById` in the audit
   * registry cannot express this — a batch has no single resource id, and the
   * rows to snapshot are named by the request body, which `fetchById` never
   * sees — so the snapshot is taken here, on both sides of the write.
   *
   * Assigning it to `auditBefore` bypasses the hook's sanitizer, so a snapshot
   * must carry only what is safe to store: ids, names, and the fields the route
   * actually changes. Never the whole row.
   */
  audit?: {
    target: { auditBefore?: unknown; auditAfter?: unknown };
    snapshot: (ids: string[]) => Promise<Record<string, unknown>>;
  };
}): Promise<BulkOutcome> {
  const requested = [...new Set(ids)];
  const visible = await load(requested);
  if (audit) {
    audit.target.auditBefore = await audit.snapshot(requested);
  }

  const succeeded: BulkOutcome["succeeded"] = [];
  const failed: BulkOutcome["failed"] = [];
  const authorized: BulkEntry<TItem>[] = [];

  for (const id of requested) {
    const item = visible.get(id);
    if (!item) {
      failed.push({ id, name: null, error: notFoundMessage });
      continue;
    }

    const name = describe(item);
    try {
      await authorize?.(item, id);
      if (applyEach) {
        await applyEach(item, id);
      } else {
        authorized.push({ id, item });
      }
      succeeded.push({ id, name });
    } catch (error) {
      const translated = translateError?.(error, item);
      if (translated !== null && translated !== undefined) {
        failed.push({ id, name, error: translated });
        continue;
      }
      if (error instanceof ApiError) {
        failed.push({ id, name, error: error.message });
        continue;
      }
      logger.error({ err: error, id }, `${logLabel}: unexpected failure`);
      failed.push({ id, name, error: unexpectedMessage });
    }
  }

  if (applyAll && authorized.length > 0) {
    await applyAll(authorized);
  }

  if (audit) {
    audit.target.auditAfter = await audit.snapshot(requested);
  }

  return { succeeded, failed };
}
