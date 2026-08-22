import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/utils";

/**
 * Runs a per-item mutation across a selection and reports the batch as one
 * outcome.
 *
 * Most resources only expose a single-item route, so a bulk action here is a
 * fan-out rather than one request. That makes partial success the normal case,
 * not the exception: this keeps going after a failure and returns what landed
 * alongside what did not, so the caller can say so instead of claiming a clean
 * sweep or rolling back work that already succeeded.
 *
 * Concurrency is deliberately small. These fan out to a route that writes, and
 * a selection of 200 firing at once is a self-inflicted thundering herd on the
 * user's own backend.
 */
export async function runBulkAction<T>({
  items,
  run,
  describe,
  concurrency = 4,
}: {
  items: readonly T[];
  run: (item: T) => Promise<unknown>;
  /** Names an item in the failure toast. */
  describe: (item: T) => string;
  concurrency?: number;
}): Promise<BulkOutcome> {
  const queue = [...items];
  const succeeded: string[] = [];
  const failed: { label: string; error: string }[] = [];

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await run(item);
        succeeded.push(describe(item));
      } catch (error) {
        failed.push({
          label: describe(item),
          error: getApiErrorMessage(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );

  return { succeeded, failed };
}

/**
 * The outcome a `/bulk` route answers with, in the terms the toast below
 * speaks. Server and client disagree only in shape: the route identifies rows
 * by id as well as name, because it has to report an id that resolved to
 * nothing the caller can see — which reads as "Unknown" here, since a name is
 * the only thing worth showing someone.
 */
export function toBulkOutcome(result: {
  succeeded: Array<{ name: string }>;
  failed: Array<{ name: string | null; error: string }>;
  affected?: number;
}): BulkOutcome {
  return {
    affected: result.affected,
    succeeded: result.succeeded.map((entry) => entry.name),
    failed: result.failed.map((entry) => ({
      label: entry.name ?? "Unknown",
      error: entry.error,
    })),
  };
}

/**
 * One toast for a whole batch, naming what failed rather than claiming a clean
 * sweep. Mirrors how the skills bulk routes report themselves, so a partly
 * applied batch reads the same wherever it happens.
 */
export function reportBulkOutcome({
  outcome,
  verb,
  failureVerb,
  noun,
  plural,
}: {
  outcome: BulkOutcome;
  /** Past tense, e.g. "Deleted". */
  verb: string;
  /** Bare infinitive for the failure line, e.g. "delete". */
  failureVerb: string;
  noun: string;
  plural?: string;
}) {
  const { succeeded, failed } = outcome;
  const count = (n: number) =>
    `${n} ${n === 1 ? noun : (plural ?? `${noun}s`)}`;
  // A filter-mode batch reports only a count: it has no per-row names, so
  // reading `succeeded.length` would announce "0" after moving thousands.
  const succeededCount = outcome.affected ?? succeeded.length;

  if (failed.length === 0) {
    toast.success(`${verb} ${count(succeededCount)}`);
    return;
  }

  const named = failed
    .slice(0, BULK_FAILURE_NAMES_SHOWN)
    .map((entry) => entry.label)
    .join(", ");
  const remaining = failed.length - BULK_FAILURE_NAMES_SHOWN;
  const description = `${remaining > 0 ? `${named} and ${remaining} more` : named} — ${failed[0].error}`;

  if (succeededCount === 0) {
    // The reason is the same for every entry in the common cases (no
    // permission, still in use), so the first one stands for the rest.
    toast.error(`Could not ${failureVerb} ${count(failed.length)}`, {
      description,
    });
    return;
  }

  toast.warning(
    `${verb} ${count(succeededCount)} — ${count(failed.length)} could not be ${failureVerb}d`,
    { description },
  );
}

export interface BulkOutcome {
  succeeded: string[];
  failed: { label: string; error: string }[];
  /**
   * Rows changed when the batch selected by filter rather than by id. Such a
   * batch has no per-row names to report — it may have moved tens of thousands
   * of rows — so the count stands in for `succeeded`.
   */
  affected?: number;
}

/** How many failures a bulk toast names before it starts counting. */
const BULK_FAILURE_NAMES_SHOWN = 3;
