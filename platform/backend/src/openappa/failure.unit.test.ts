import { describe, expect, test } from "vitest";
import { openappaFailure } from "./failure";

describe("openappaFailure", () => {
  test("names a refused policy and tells clients not to retry it", () => {
    const cause = new Error(
      'unsupported policy: tool "grain__*" has an invalid qualified identity',
    );

    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(500);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      'OpenAPPA could not safely complete this operation: the organization\'s guardrails policy was refused (unsupported policy: tool "grain__*" has an invalid qualified identity). An administrator can fix it on the OpenAPPA page.',
    );
    expect(failure.cause).toBe(cause);
  });

  test("keeps runtime and storage diagnostics out of the message and allows a retry", () => {
    for (const cause of [
      new Error(
        "storage failure: connect postgresql://app:secret@db.internal/archestra",
      ),
      new Error("private native database error"),
      "not even an error",
    ]) {
      const failure = openappaFailure(cause);

      expect(failure.statusCode).toBe(503);
      expect(failure.shouldRetry).toBe(true);
      expect(failure.retryAfterSeconds).toBeGreaterThan(0);
      expect(failure.message).toBe(
        "OpenAPPA could not safely complete this operation: the policy runtime is unavailable.",
      );
    }
  });

  test("names an exhausted connection pool without its internals", () => {
    const failure = openappaFailure(
      new Error(
        "OpenAPPA had no free PostgreSQL connection in time; retry later",
      ),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: the policy runtime has no free database connection.",
    );
  });

  test.each([
    "no prepared fork to open this child",
    "parent session has not started",
  ])("an unchecked child cannot be repaired by retrying: %s", (message) => {
    const cause = new Error(message);
    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toContain("start a new subagent");
    expect(failure.cause).toBe(cause);
  });

  test("strips URL credentials and bounds the detail of a refused policy", () => {
    const failure = openappaFailure(
      new Error(
        `configuration refused: annotator at https://user:token@example.com/annotate ${"x".repeat(400)}`,
      ),
    );

    expect(failure.statusCode).toBe(500);
    expect(failure.message).not.toContain("user:token");
    expect(failure.message).toContain("https://example.com/annotate");
    expect(failure.message.length).toBeLessThan(420);
  });

  test("fails a retained session closed when replay retention has expired", () => {
    const failure = openappaFailure(
      new Error("OpenAPPA replay retention expired"),
    );

    expect(failure.statusCode).toBe(410);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: replay retention expired. Start a new session instead of continuing this one.",
    );
  });

  test("does not wrap a failure twice", () => {
    const first = openappaFailure(new Error("unsupported policy: x"));

    expect(openappaFailure(first)).toBe(first);
  });
});
