import { describe, expect, test } from "vitest";
import {
  OpenappaRetiredAnnotatorError,
  OpenappaRootOnlyError,
  openappaFailure,
  unansweredAnnotationNotice,
} from "./failure";

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
      'OpenAPPA could not safely complete this operation: the organization\'s guardrails policy was refused (unsupported policy: tool "grain__*" has an invalid qualified identity). An administrator can fix it on the Guardrails page.',
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

  test.each([
    "OpenAPPA processing interrupted: the opening policy is unavailable: the stored policy file compiles to a different identity than the opening of archestra:f779b8",
    "OpenAPPA result refused: the opening policy is unavailable: the policy file 0a1b is not stored",
  ])("tells a conversation whose opening policy cannot reopen to start again: %s", (message) => {
    const cause = new Error(message);

    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: this conversation started under a guardrails policy that the policy runtime cannot reopen. Start a new conversation.",
    );
    expect(failure.cause).toBe(cause);
  });

  test("a missing tool contract is not a transient runtime outage", () => {
    const cause = new Error(
      "OpenAPPA processing interrupted: tool host/archestra/WebFetch is not declared in this policy and no wildcard covers it; the call is refused before it runs",
    );

    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(500);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toContain("no contract for the requested tool");
    expect(failure.message).not.toContain("runtime is unavailable");
    expect(failure.cause).toBe(cause);
  });

  test("does not interpret an unrecognized native failure as a missing contract", () => {
    const failure = openappaFailure(
      new Error(
        "OpenAPPA processing interrupted: tool storage unavailable; is not declared in this policy",
      ),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
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
    "OpenAPPA processing interrupted: annotator unavailable",
    "OpenAPPA remedy awaiting an answer: consult pending",
    "OpenAPPA remedy is still executing; retry later",
    "OpenAPPA result refused: transport unavailable",
  ])("keeps an interrupted native operation retryable: %s", (message) => {
    const cause = new Error(message);
    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: the policy runtime is unavailable.",
    );
    expect(failure.cause).toBe(cause);
  });

  test("a session whose annotator the policy retired is not retried", () => {
    const cause = new OpenappaRetiredAnnotatorError("jev.tool-call");
    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      'OpenAPPA could not safely complete this operation: this conversation started under a policy that no longer declares annotator "jev.tool-call". Start a new conversation, or an administrator can declare "jev.tool-call" again on the Guardrails page.',
    );
    expect(failure.cause).toBe(cause);
  });

  test.each([
    "OpenAPPA processing interrupted: annotator=x error=timeout",
    "OpenAPPA processing interrupted: annotator=x error=unreachable",
    "OpenAPPA processing interrupted: annotator=x error=unregistered",
  ])("a runtime message alone does not decide retryability: %s", (message) => {
    const failure = openappaFailure(new Error(message));

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
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

  test("a dispatch that lost its lease asks the client to retry", () => {
    const failure = openappaFailure(
      new Error("OpenAPPA lost its lease on this operation; retry the request"),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: another request of this session took over this operation. Retry the request.",
    );
  });

  test("an operation another request still works on asks the client to retry", () => {
    const failure = openappaFailure(
      new Error(
        "OpenAPPA is processing this operation in another request; retry the request",
      ),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: another request of this session is still working on this operation. Retry the request.",
    );
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

  test("a policy with no composition that ever opened is refused, not retried", () => {
    for (const cause of [
      new OpenappaRootOnlyError(
        "policy refused: tool mcp/acme/list names annotator nobody.declares",
      ),
      // What the runtime says if a root text alone still reaches it.
      new Error(
        "a hosted document declares \"include\", which is the host's to declare, not the policy's",
      ),
    ]) {
      const failure = openappaFailure(cause);
      expect(failure.statusCode).toBe(500);
      expect(failure.shouldRetry).toBe(false);
    }
    expect(
      openappaFailure(new OpenappaRootOnlyError("policy refused: x")).message,
    ).toBe(
      "OpenAPPA could not safely complete this operation: the organization's guardrails policy was refused and no earlier composition exists (policy refused: x). An administrator can fix it on the Guardrails page.",
    );
  });

  test("does not wrap a failure twice", () => {
    const first = openappaFailure(new Error("unsupported policy: x"));

    expect(openappaFailure(first)).toBe(first);
  });
});

describe("unansweredAnnotationNotice", () => {
  test("turns an annotator timeout, as the service receives it, into a retry notice", () => {
    const failure = openappaFailure(
      new Error(
        "OpenAPPA processing interrupted: annotator=archestra.tool-call error=timeout",
      ),
    );

    expect(unansweredAnnotationNotice(failure)).toBe(
      '[appa] Not checked: OpenAPPA could not rule on this call because its annotator "archestra.tool-call" did not answer in time. The call did not run. Make the same call again to retry. If it fails the same way again, stop and tell the user that Guardrails could not check this call.',
    );
  });

  test.each([
    ["unreachable", "could not be reached"],
    ['non_success status=502 detail="upstream reset"', "returned an error"],
    ["non_success status=429", "returned an error"],
  ])("advises one retry when another attempt can succeed: %s", (reason, phrase) => {
    const notice = unansweredAnnotationNotice(
      new Error(
        `OpenAPPA processing interrupted: annotator=github.repository-visibility error=${reason}`,
      ),
    );

    expect(notice).toContain(`"github.repository-visibility" ${phrase}.`);
    expect(notice).toContain("Make the same call again to retry.");
    expect(notice).not.toContain("upstream reset");
  });

  test.each([
    ["unregistered", "is not set up in this deployment"],
    [
      'non_success status=409 detail="No LLM provider API key is configured for this organization."',
      "returned an error",
    ],
    ["malformed delta.audience", "returned an answer OpenAPPA could not read"],
  ])("does not invite a retry that cannot help: %s", (reason, phrase) => {
    const notice = unansweredAnnotationNotice(
      new Error(
        `OpenAPPA processing interrupted: annotator=archestra.tool-call error=${reason}`,
      ),
    );

    expect(notice).toContain(`"archestra.tool-call" ${phrase}.`);
    expect(notice).toContain("Retrying it will not help.");
    expect(notice).not.toContain("No LLM provider API key");
    expect(notice).not.toContain("delta.audience");
  });

  test.each([
    "private native database error",
    "OpenAPPA processing interrupted: annotator unavailable",
    "OpenAPPA processing interrupted: the opening policy is unavailable: the stored policy file compiles to a different identity",
    "OpenAPPA lost its lease on this operation; retry the request",
  ])("leaves every other failure to fail the request: %s", (message) => {
    expect(
      unansweredAnnotationNotice(openappaFailure(new Error(message))),
    ).toBe(null);
  });
});
