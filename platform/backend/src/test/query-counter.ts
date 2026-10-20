/**
 * Count the SQL statements a piece of code sends to the test database, and
 * the rows each returns (`rowCounts[i]` for `statements[i]`).
 *
 * Observes the real PGlite boundary without replacing it: every statement
 * still executes. Statements inside a transaction run on the transaction
 * object rather than the PGlite instance, so the transaction entry point is
 * wrapped to count those too.
 */

import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { drainBackgroundWork } from "@/utils/background-work";

export async function recordQueries<T>(
  run: () => Promise<T>,
): Promise<{ result: T; statements: string[]; rowCounts: number[] }> {
  const statements: string[] = [];
  const rowCounts: number[] = [];
  const record = (sql: unknown, result: Promise<unknown>) => {
    const index =
      statements.push(typeof sql === "string" ? sql : String(sql)) - 1;
    rowCounts[index] = 0;
    return result.then((value) => {
      rowCounts[index] = returnedRows(value);
      return value;
    });
  };
  const prototype = PGlite.prototype as unknown as Record<
    "query" | "exec" | "transaction",
    (...args: unknown[]) => Promise<unknown>
  >;
  const query = prototype.query;
  const exec = prototype.exec;
  const transaction = prototype.transaction;
  const spies = [
    vi.spyOn(prototype, "query").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      return record(args[0], Reflect.apply(query, this, args));
    }),
    vi.spyOn(prototype, "exec").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      return record(args[0], Reflect.apply(exec, this, args));
    }),
    vi.spyOn(prototype, "transaction").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      const [callback] = args as [(tx: TransactionLike) => Promise<unknown>];
      return Reflect.apply(transaction, this, [
        (tx: TransactionLike) => callback(countingTransaction(tx, record)),
      ]);
    }),
  ];
  try {
    const result = await run();
    await drainBackgroundWork();
    return { result, statements, rowCounts };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

type TransactionLike = {
  query: (...args: unknown[]) => Promise<unknown>;
  exec: (...args: unknown[]) => Promise<unknown>;
};

function countingTransaction(
  tx: TransactionLike,
  record: (sql: unknown, result: Promise<unknown>) => Promise<unknown>,
): TransactionLike {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        (prop === "query" || prop === "exec") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) =>
          record(args[0], Reflect.apply(value, target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Rows a PGlite `query` result (or each of an `exec`'s results) returned. */
function returnedRows(result: unknown): number {
  const results = Array.isArray(result) ? result : [result];
  return results.reduce(
    (total: number, entry) =>
      total +
      (entry && typeof entry === "object" && "rows" in entry
        ? ((entry as { rows: unknown[] }).rows?.length ?? 0)
        : 0),
    0,
  );
}
