import { DrizzleQueryError } from "drizzle-orm/errors";
import { DatabaseError } from "pg";
import { describe, expect, test } from "vitest";
import { isDeadlockError } from "./deadlock";

function pgError(code: string): DatabaseError {
  const error = new DatabaseError("server error", 0, "error");
  error.code = code;
  return error;
}

describe("isDeadlockError", () => {
  test("recognizes a deadlock reported by the driver", () => {
    expect(isDeadlockError(pgError("40P01"))).toBe(true);
  });

  test("recognizes a deadlock wrapped by Drizzle", () => {
    expect(
      isDeadlockError(new DrizzleQueryError("UPDATE x", [], pgError("40P01"))),
    ).toBe(true);
  });

  test("rejects other database errors", () => {
    expect(isDeadlockError(pgError("40001"))).toBe(false);
    expect(
      isDeadlockError(new DrizzleQueryError("UPDATE x", [], pgError("23505"))),
    ).toBe(false);
    expect(isDeadlockError(new Error("deadlock detected"))).toBe(false);
  });
});
