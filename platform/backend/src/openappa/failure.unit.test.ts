import { describe, expect, test, vi } from "vitest";
import logger from "@/logging";
import { ApiError } from "@/types/api";
import {
  OpenappaRootOnlyError,
  openappaFailure,
  unansweredAnnotationNotice,
} from "./failure";

vi.mock("@/logging");

describe("openappaFailure", () => {
  test("names a refused policy and tells clients not to retry it", () => {
    const cause = runtimeFailure(
      "policy_refused",
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
    for (const [cause, detail] of [
      [
        runtimeFailure(
          "storage",
          "storage failure: connect postgresql://app:secret@db.internal/archestra",
        ),
        "the policy runtime is unavailable (code: storage).",
      ],
      [
        runtimeFailure(
          "panicked",
          "OpenAPPA panicked; operation was not released",
        ),
        "the policy runtime is unavailable (code: panicked).",
      ],
      [
        runtimeFailure(
          "replay_timed_out",
          "OpenAPPA replay exceeded its 120 second limit",
        ),
        "the policy runtime is unavailable (code: replay_timed_out).",
      ],
      [
        new Error("private native database error"),
        "the policy runtime is unavailable (code: unknown).",
      ],
      [
        "not even an error",
        "the policy runtime is unavailable (code: unknown).",
      ],
    ] as const) {
      const failure = openappaFailure(cause);

      expect(failure.statusCode).toBe(503);
      expect(failure.shouldRetry).toBe(true);
      expect(failure.retryAfterSeconds).toBeGreaterThan(0);
      expect(failure.message).toBe(
        `OpenAPPA could not safely complete this operation: ${detail}`,
      );
    }
  });

  test("tells clients not to retry content the database refuses", () => {
    vi.mocked(logger.error).mockClear();
    for (const state of ["22P05", "22021"]) {
      const failure = openappaFailure(
        runtimeFailure(
          "storage",
          `receipt storage failed: PostgreSQL ERROR (SQLSTATE ${state})`,
        ),
      );

      expect(failure.statusCode).toBe(409);
      expect(failure.shouldRetry).toBe(false);
      expect(failure.retryAfterSeconds).toBeUndefined();
      expect(failure.message).toBe(
        `OpenAPPA could not safely complete this operation: the database refused content in this conversation (code: storage, SQLSTATE ${state}). The same request fails again. Remove that content or start a new conversation.`,
      );
    }
    // The database write failed on this server, so its cause is logged.
    expect(logger.error).toHaveBeenCalledTimes(2);

    for (const message of [
      "receipt storage failed: PostgreSQL ERROR (SQLSTATE 40001)",
      "PostgreSQL storage failure: error performing TLS handshake",
    ]) {
      const failure = openappaFailure(runtimeFailure("storage", message));

      expect(failure.statusCode).toBe(503);
      expect(failure.shouldRetry).toBe(true);
    }
  });

  test("logs the cause and its code without URL credentials", () => {
    vi.mocked(logger.error).mockClear();

    openappaFailure(
      runtimeFailure(
        "storage",
        "storage failure: connect postgresql://app:secret@db.internal/archestra",
      ),
    );

    expect(logger.error).toHaveBeenCalledWith(
      {
        code: "storage",
        cause: "storage failure: connect postgresql://db.internal/archestra",
      },
      "OpenAPPA could not safely complete an operation",
    );
  });

  test("does not log a failure the client caused", () => {
    vi.mocked(logger.error).mockClear();

    openappaFailure(runtimeFailure("untrusted_log", "stored batch 7"));

    expect(logger.error).not.toHaveBeenCalled();
  });

  test("tells a conversation whose stored record no longer decodes to start again, without retrying", () => {
    const cause = runtimeFailure(
      "untrusted_log",
      "OpenAPPA processing interrupted: the persisted log is refused: stored batch 7 does not decode: expected value at line 1 column 4264",
    );

    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: the policy runtime cannot read this conversation's stored guardrails record. Start a new conversation.",
    );
    expect(failure.cause).toBe(cause);
  });

  test("classifies by the runtime's code, not by its wording", () => {
    const failure = openappaFailure(
      runtimeFailure("untrusted_log", "reworded by a later runtime"),
    );

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
  });

  test("tells a conversation whose opening policy cannot reopen to start again", () => {
    const cause = runtimeFailure(
      "policy_unavailable",
      "OpenAPPA processing interrupted: the opening policy is unavailable: the policy file 0a1b is not stored",
    );

    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: this conversation started under a guardrails policy that the policy runtime cannot reopen. Start a new conversation.",
    );
    expect(failure.cause).toBe(cause);
  });

  test("names an exhausted connection pool without its internals", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "pool_exhausted",
        "OpenAPPA had no free PostgreSQL connection in time; retry later",
      ),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: the policy runtime has no free database connection.",
    );
  });

  test("keeps an operational refusal with no specific remedy retryable", () => {
    const failure = openappaFailure(
      runtimeFailure("storage", "storage failure: disk full"),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
  });

  test.each([
    "OpenAPPA processing interrupted: annotator unavailable",
    "OpenAPPA remedy interrupted: storage unavailable",
    "OpenAPPA remedy is still executing; retry later",
    "OpenAPPA result refused: transport unavailable",
  ])("keeps an interrupted native operation retryable: %s", (message) => {
    const cause = new Error(message);
    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: the policy runtime is unavailable (code: unknown).",
    );
    expect(failure.cause).toBe(cause);
  });

  test("a conversation opened under the earlier policy model is refused once, not retried", () => {
    const cause = runtimeFailure(
      "legacy_family",
      "this trajectory family was opened before live policy revisions; open a new one",
    );
    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: This conversation was opened under an earlier policy model. Start a new conversation.",
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
    "spawn_not_taken",
    "unstarted_parent",
  ] as const)("an unchecked child cannot be repaired by retrying: %s", (code) => {
    const cause = runtimeFailure(code, "refused");
    const failure = openappaFailure(cause);

    expect(failure.statusCode).toBe(409);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.cause).toBe(cause);
  });

  test("a dispatch that lost its lease asks the client to retry", () => {
    const failure = openappaFailure(runtimeFailure("lease_lost", "lost"));

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: another request of this session took over this operation. Retry the request.",
    );
  });

  test("an operation another request still works on asks the client to retry", () => {
    const failure = openappaFailure(runtimeFailure("held_elsewhere", "held"));

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
    expect(failure.message).toBe(
      "OpenAPPA could not safely complete this operation: another request of this session is still working on this operation. Retry the request.",
    );
  });

  test("a policy that moved past the dispatch asks the client to retry and is never model feedback", () => {
    for (const cause of [
      runtimeFailure(
        "policy_moved",
        "OpenAPPA published a newer policy revision for this organization; retry the request",
      ),
      // The runtime's own refusal, should it reach the host unconverted.
      new Error(
        "OpenAPPA processing interrupted: deployment org-1 moved to policy revision 4 while this event was decided; retry it",
      ),
    ]) {
      const failure = openappaFailure(cause);

      expect(failure.statusCode).toBe(503);
      expect(failure.shouldRetry).toBe(true);
      expect(failure.retryAfterSeconds).toBeGreaterThan(0);
      expect(failure.message).toBe(
        "OpenAPPA could not safely complete this operation: the organization's guardrails policy changed while this request was checked. Retry the request.",
      );
      expect(unansweredAnnotationNotice(failure)).toBeNull();
    }
  });

  test("strips URL credentials and bounds the detail of a refused policy", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "policy_refused",
        `configuration refused: annotator at https://user:token@example.com/annotate ${"x".repeat(400)}`,
      ),
    );

    expect(failure.statusCode).toBe(500);
    expect(failure.message).not.toContain("user:token");
    expect(failure.message).toContain("https://example.com/annotate");
    expect(failure.message.length).toBeLessThan(420);
  });

  test("a missing deployment setting is not retried and leaks no credential", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "runtime_misconfigured",
        `annotator judge names the builtin "archestra", but the host supplies no archestra endpoint at https://user:token@example.com ${"x".repeat(400)}`,
      ),
    );

    expect(failure.statusCode).toBe(500);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).not.toContain("user:token");
    expect(failure.message.length).toBeLessThan(500);
  });

  test("a request the binding cannot read is not retried and its detail stays out", () => {
    const failure = openappaFailure(
      runtimeFailure("invalid_input", "invalid session identity: secret-id"),
    );

    expect(failure.statusCode).toBe(500);
    expect(failure.shouldRetry).toBe(false);
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.message).not.toContain("secret-id");
  });

  test("a refusal's wording without its code stays a retryable outage", () => {
    const failure = openappaFailure(
      new Error("unsupported policy: tool x has an invalid qualified identity"),
    );

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
  });

  test("a policy with no composition that ever opened is refused, not retried", () => {
    for (const cause of [
      new OpenappaRootOnlyError(
        "policy refused: tool mcp/acme/list names annotator nobody.declares",
      ),
      // What the runtime says if a root text alone still reaches it.
      runtimeFailure(
        "policy_refused",
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
    const cause = runtimeFailure("policy_refused", "unsupported policy: x");
    const first = openappaFailure(cause);

    expect(first).toBeInstanceOf(ApiError);
    expect(openappaFailure(first)).toBe(first);
    expect(first.cause).toBe(cause);
  });

  test("an ApiError raised elsewhere is classified, not passed through", () => {
    const failure = openappaFailure(new ApiError(400, "bad request"));

    expect(failure.statusCode).toBe(503);
    expect(failure.shouldRetry).toBe(true);
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

// ===

/** A native failure as the binding's loader hands it over: the runtime's class on `code`. */
function runtimeFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
