/**
 * Count the SQL statements a piece of code sends to the test database.
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
): Promise<{ result: T; statements: string[] }> {
  const statements: string[] = [];
  const record = (sql: unknown) => {
    statements.push(typeof sql === "string" ? sql : String(sql));
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
      record(args[0]);
      return Reflect.apply(query, this, args);
    }),
    vi.spyOn(prototype, "exec").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      record(args[0]);
      return Reflect.apply(exec, this, args);
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
    return { result, statements };
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
  record: (sql: unknown) => void,
): TransactionLike {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        (prop === "query" || prop === "exec") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          record(args[0]);
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
