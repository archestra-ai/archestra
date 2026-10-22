import { describe, expect, test, vi } from "vitest";
import logger from "@/logging";
import { ApiError } from "@/types/api";
import {
  OpenappaCredentialError,
  OpenappaRootOnlyError,
  openappaFailure,
  unansweredAnnotationNotice,
} from "./failure";

vi.mock("@/logging");

const NUL_TEXT =
  "Guardrails cannot store this conversation because it contains a NUL character (U+0000), usually from a tool that printed binary data. Every retry sends the same conversation and fails the same way. Rewind the conversation to before that tool output, or start a new conversation.";
const STORAGE_TRANSIENT_TEXT =
  "Guardrails could not save its decision for this request because its database was busy or unreachable. Retry the request in a few seconds.";
const DEFECT_TEXT =
  "Guardrails failed unexpectedly while checking this request. Retrying will not help. Give this reference to your administrator.";
const SERVICE_UNREACHABLE_TEXT =
  "Guardrails could not reach a service it needs. Retry the request in a few seconds.";

describe("openappaFailure: storage", () => {
  test.each([
    "receipt storage failed: PostgreSQL ERROR (SQLSTATE 22P05)",
    'OpenAPPA processing interrupted: storage failure: receipt storage failed: PostgreSQL ERROR (SQLSTATE 22021); table="openappa_processed_results"',
  ])("a NUL the database cannot store is the request's own fault and is not retried: %s", (message) => {
    const cause = runtimeFailure("storage", message);

    const failure = openappaFailure(cause);

    expectNoRetry(failure, 400);
    expect(failure.message).toBe(NUL_TEXT);
    expect(failure.cause).toBe(cause);
  });

  test("logs a NUL failure as a warning with its SQLSTATE", () => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();

    openappaFailure(
      runtimeFailure(
        "storage",
        "receipt storage failed: PostgreSQL ERROR (SQLSTATE 22P05)",
      ),
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        code: "storage",
        status: 400,
        sqlstate: "22P05",
        cause: "receipt storage failed: PostgreSQL ERROR (SQLSTATE 22P05)",
      },
      "OpenAPPA could not safely complete an operation",
    );
  });

  test.each([
    "08006",
    "08001",
    "40001",
    "40P01",
    "53300",
    "55P03",
    "57014",
    "57P01",
    "57P03",
    "25006",
  ])("a SQLSTATE a retry can get past is retryable: %s", (sqlstate) => {
    const failure = openappaFailure(
      runtimeFailure(
        "storage",
        `PostgreSQL storage failure: PostgreSQL FATAL (SQLSTATE ${sqlstate})`,
      ),
    );

    expectRetry(failure);
    expect(failure.message).toBe(STORAGE_TRANSIENT_TEXT);
  });

  test.each([
    "error connecting to server: Connection refused (os error 111)",
    "receipt storage failed: connection closed",
    "the PostgreSQL connection did not open in time",
    "connection worker stopped",
    "PostgreSQL connection failed: no PostgreSQL connection became free within 30s",
    "receipt storage failed: the operation receipt changed under every claim attempt",
    "receipt is absent or no longer pending",
    "receipt was completed with a different value",
    "a storage failure in a shape this host does not know",
  ])("a storage failure without a SQLSTATE stays retryable: %s", (message) => {
    const failure = openappaFailure(runtimeFailure("storage", message));

    expectRetry(failure);
    expect(failure.message).toBe(STORAGE_TRANSIENT_TEXT);
  });

  test.each([
    "42P01",
    "42501",
    "28P01",
    "3D000",
    "23505",
    "22003",
    "XX000",
  ])("any other SQLSTATE is not retried and is named: %s", (sqlstate) => {
    const failure = openappaFailure(
      runtimeFailure(
        "storage",
        `storage failure: postgresql://app:secret@db.internal/archestra PostgreSQL ERROR (SQLSTATE ${sqlstate})`,
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      `Guardrails could not save its decision for this request because its database refused the write (SQLSTATE ${sqlstate}). Retrying will not help. Give this reference to your administrator. (code: storage)`,
    );
  });

  test.each([
    "SQLSTATE 22P05",
    "(SQLSTATE 22P0)",
    "(sqlstate 22p05)",
  ])("reads a SQLSTATE only in the runtime's own shape: %s", (text) => {
    const failure = openappaFailure(
      runtimeFailure("storage", `receipt storage failed: ${text}`),
    );

    expectRetry(failure);
  });

  test.each([
    "receipt storage failed: operation receipt has an invalid status",
    "released call receipt lacks call context",
  ])("a stored record the runtime cannot use is not retried: %s", (message) => {
    const failure = openappaFailure(runtimeFailure("storage", message));

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      "Guardrails found a stored record of this request that it cannot use. Retrying will not help. Give this reference to your administrator. (code: storage)",
    );
  });

  test("peer sharing under conversation encryption is a limit of the request, not an outage", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "storage",
        "OpenAPPA peer storage failed: peer sharing is unavailable for an encrypted storage view",
      ),
    );

    expectNoRetry(failure, 400);
    expect(failure.message).toBe(
      "Guardrails cannot share messages between sessions while conversation encryption is on. Send the content another way.",
    );
  });

  test("logs the cause, its classification and SQLSTATE without URL credentials", () => {
    vi.mocked(logger.error).mockClear();

    openappaFailure(
      runtimeFailure(
        "storage",
        "storage failure: connect postgresql://app:secret@db.internal/archestra (SQLSTATE 08006)",
      ),
    );

    expect(logger.error).toHaveBeenCalledWith(
      {
        code: "storage",
        status: 503,
        sqlstate: "08006",
        cause:
          "storage failure: connect postgresql://db.internal/archestra (SQLSTATE 08006)",
      },
      "OpenAPPA could not safely complete an operation",
    );
  });
});

describe("openappaFailure: transient runtime failures", () => {
  test.each([
    [
      "pool_exhausted",
      "Guardrails has no free database connection right now. Retry the request in a few seconds.",
    ],
    [
      "contended",
      "Guardrails could not record this request because other requests of this conversation kept changing its record. Retry the request in a few seconds.",
    ],
    [
      "replay_busy",
      "Too many Guardrails policy tests are running. Retry in a few seconds.",
    ],
    [
      "lease_lost",
      "Another request of this conversation took over this Guardrails check. Retry the request.",
    ],
    [
      "held_elsewhere",
      "Another request of this conversation is still working on this Guardrails check, for example while a reviewer decides on an approval. Retry the request later.",
    ],
    [
      "policy_moved",
      "The organization's Guardrails policy changed while this request was checked. Retry the request.",
    ],
  ])("%s is retried after a pause", (code, text) => {
    const failure = openappaFailure(runtimeFailure(code, "runtime detail"));

    expectRetry(failure);
    expect(failure.message).toBe(text);
  });

  test("a policy-moved refusal without its class is still retried", () => {
    const failure = openappaFailure(
      new Error(
        "OpenAPPA processing interrupted: deployment default-org moved to policy revision 2 while this event was decided; retry it",
      ),
    );

    expectRetry(failure);
  });
});

describe("openappaFailure: annotators", () => {
  test.each([
    ["timeout", "did not answer in time"],
    ["unreachable", "could not be reached"],
    ["transport", "could not be reached"],
    ['non_success status=502 detail="upstream reset"', "returned an error"],
    ["non_success status=429", "returned an error"],
  ])("an annotator that can answer on a second attempt is retried: %s", (reason, phrase) => {
    const failure = openappaFailure(
      runtimeFailure(
        "annotation_refused",
        `OpenAPPA processing interrupted: annotator=bash-classifier error=${reason}`,
      ),
    );

    expectRetry(failure);
    expect(failure.message).toBe(
      `Guardrails could not check this request because its annotator "bash-classifier" ${phrase}. Retry the request in a few seconds.`,
    );
    expect(failure.message).not.toContain("upstream reset");
  });

  test.each([
    ["unregistered", "is not set up in this deployment"],
    ["malformed delta.audience", "returned an answer OpenAPPA could not read"],
    ["oversized", "returned an answer that was too large"],
    [
      'non_success status=409 detail="No LLM provider API key is configured"',
      "returned an error",
    ],
    [
      "non_success status=1; this tool has no exact policy contract; run /appa-guide to write rules for this tool",
      "returned an error",
    ],
  ])("an annotator an administrator must fix is not retried: %s", (reason, phrase) => {
    const failure = openappaFailure(
      runtimeFailure(
        "annotation_refused",
        `OpenAPPA processing interrupted: annotator=claude-code.undeclared-tool error=${reason}`,
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      `Guardrails could not check this request because its annotator "claude-code.undeclared-tool" ${phrase}. An administrator can check the annotator on the Guardrails page. (code: annotation_refused)`,
    );
    expect(failure.message).not.toContain("API key");
  });

  test("a refusal of the model's own appa/do_something arguments is the request's fault", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "annotation_refused",
        "OpenAPPA processing interrupted: annotator=appa/do_something error=appa/do_something takes one argument, `requires`; found `audience`",
      ),
    );

    expectNoRetry(failure, 400);
    expect(failure.message).toBe(
      "Guardrails refused the arguments of appa/do_something: appa/do_something takes one argument, `requires`; found `audience`. Change the request and try again.",
    );
  });
});

describe("openappaFailure: configuration", () => {
  test("names a refused policy and tells clients not to retry it", () => {
    const cause = runtimeFailure(
      "policy_refused",
      'unsupported policy: tool "grain__*" has an invalid qualified identity',
    );

    const failure = openappaFailure(cause);

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      'Guardrails refused the organization\'s policy (unsupported policy: tool "grain__*" has an invalid qualified identity). An administrator can fix it on the Guardrails page.',
    );
    expect(failure.cause).toBe(cause);
  });

  test("strips URL credentials and bounds the detail of a refused policy", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "policy_refused",
        `consult https://user:pass@helper.internal/x ${"y".repeat(400)}`,
      ),
    );

    expect(failure.message).not.toContain("user:pass");
    expect(failure.message).toContain("https://helper.internal/x");
    expect(failure.message.length).toBeLessThan(400);
  });

  test("a missing deployment setting is not retried and leaks no credential", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "runtime_misconfigured",
        "builtin archestra needs ARCHESTRA_URL=https://svc:token@archestra.internal",
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).not.toContain("svc:token");
    expect(failure.message).toContain("The operator of this deployment");
  });

  test("a tool the policy does not declare names the tool and the page that declares it", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "undeclared_tool",
        "OpenAPPA processing interrupted: tool mcp/crm/search_records is not declared in this policy and no wildcard covers it; the call is refused before it runs",
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      'Guardrails cannot check the tool "mcp/crm/search_records" because the organization\'s policy does not declare it. An administrator can add it on the Guardrails page. (code: undeclared_tool)',
    );
  });

  test("helpers that never settle need an administrator", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "resolution_diverged",
        "external resolution did not settle after 8 rounds",
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toContain("(code: resolution_diverged)");
  });

  test("a policy test over its time limit is not retried", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "replay_timed_out",
        "OpenAPPA replay exceeded its 120 second limit",
      ),
    );

    expectNoRetry(failure, 500);
  });

  test("a malformed member address needs an administrator and is not quoted", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "principal",
        'OpenAPPA processing interrupted: the session principal "ada at example" is not an address',
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).not.toContain("ada at example");
    expect(failure.message).toContain("(code: principal)");
  });

  test("a policy with no composition that ever opened is refused, not retried", () => {
    const failure = openappaFailure(
      new OpenappaRootOnlyError("policy refused: x"),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      "Guardrails refused the organization's policy, and no earlier version of it can run (policy refused: x). An administrator can fix it on the Guardrails page.",
    );
  });

  test("a credential the policy needs is named, not retried", () => {
    const failure = openappaFailure(
      new OpenappaCredentialError("GITHUB_TOKEN", new Error("vault sealed")),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toContain("GITHUB_TOKEN");
    expect(failure.message).not.toContain("vault sealed");
  });
});

describe("openappaFailure: defects", () => {
  test.each([
    "panicked",
    "engine_invariant",
    "inventory_refused",
    "invalid_input",
    "dispatch",
    "outstanding_call",
    "call_id_reused",
    "undeclared_spawn",
  ])("%s is reported with its code and none of the runtime's detail", (code) => {
    const failure = openappaFailure(
      runtimeFailure(
        code,
        "tool mcp/crm/search_records for ada@example.com: postgresql://app:secret@db",
      ),
    );

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(`${DEFECT_TEXT} (code: ${code})`);
  });

  test.each([
    new Error("private native database error"),
    "not even an error",
    new ApiError(400, "bad request"),
    Object.assign(new Error("relation missing"), { code: "42P01" }),
  ])("a failure without a runtime class is not retried: %s", (cause) => {
    const failure = openappaFailure(cause);

    expectNoRetry(failure, 500);
    expect(failure.message).toBe(
      "Guardrails failed unexpectedly while checking this request. Give this reference to your administrator. (code: unknown)",
    );
  });

  test.each([
    new ApiError(502, "GitHub returned HTTP 503 for the App"),
    new ApiError(429, "rate limited"),
  ])("an upstream's own outage, relayed by the host, is retried: %s", (cause) => {
    const failure = openappaFailure(cause);

    expectRetry(failure);
    expect(failure.message).toBe(SERVICE_UNREACHABLE_TEXT);
  });

  test.each([
    new Error("Failed query", {
      cause: Object.assign(new Error("terminating connection"), {
        code: "57P01",
      }),
    }),
  ])("the host's own transient database failure is retried: %s", (cause) => {
    const failure = openappaFailure(cause);

    expectRetry(failure);
    expect(failure.message).toBe(STORAGE_TRANSIENT_TEXT);
  });

  test.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("the host failing to reach another service is retried without blaming the database: %s", (code) => {
    const failure = openappaFailure(
      new Error("fetch failed", {
        cause: Object.assign(new Error(`connect ${code} 10.0.0.1:8200`), {
          code,
        }),
      }),
    );

    expectRetry(failure);
    expect(failure.message).toBe(SERVICE_UNREACHABLE_TEXT);
  });

  test("a request the host gave up waiting on is retried", () => {
    const failure = openappaFailure(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );

    expectRetry(failure);
    expect(failure.message).toBe(SERVICE_UNREACHABLE_TEXT);
  });
});

describe("openappaFailure: conversations that cannot continue", () => {
  test.each([
    [
      "untrusted_log",
      "OpenAPPA processing interrupted: the persisted log is refused: stored batch 7 does not decode",
      "Guardrails cannot read the stored record of this conversation. Start a new conversation.",
    ],
    [
      "policy_unavailable",
      "OpenAPPA processing interrupted: the policy is unavailable: the policy file 0a1b is not stored",
      "This conversation started under a Guardrails policy that can no longer be loaded. Start a new conversation.",
    ],
    [
      "legacy_family",
      "this trajectory family was opened before live policy revisions; open a new one",
      "This conversation was opened under an earlier Guardrails policy model. Start a new conversation.",
    ],
    [
      "trajectory_ended",
      "OpenAPPA processing interrupted: the trajectory has ended",
      "Guardrails cannot continue this conversation. Start a new one.",
    ],
    [
      "trajectory",
      "OpenAPPA processing interrupted: no trajectory with this id exists",
      "Guardrails cannot continue this conversation. Start a new one.",
    ],
    [
      "spawn",
      "OpenAPPA processing interrupted: the fork and the child are already bound elsewhere",
      "Guardrails cannot continue this subagent. Start a new subagent.",
    ],
    [
      "spawn_not_taken",
      "the spawn did not take: no prepared fork to open this child",
      "Guardrails refuses this subagent because it did not start through a checked spawn, for example because it started while Guardrails was off. Start a new subagent to continue its work.",
    ],
    [
      "principal",
      "OpenAPPA processing interrupted: the session already acts for another principal",
      "Guardrails opened this conversation for another user. Start a new conversation.",
    ],
  ])("%s asks for a new conversation and is not retried", (code, message, text) => {
    const failure = openappaFailure(runtimeFailure(code, message));

    expectNoRetry(failure, 409);
    expect(failure.message).toBe(text);
  });

  test("records a failure the conversation's state caused without alarm", () => {
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();

    openappaFailure(
      runtimeFailure(
        "principal",
        "OpenAPPA processing interrupted: the session already acts for another principal",
      ),
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        code: "principal",
        status: 409,
        cause:
          "OpenAPPA processing interrupted: the session already acts for another principal",
      },
      "OpenAPPA could not safely complete an operation",
    );
  });

  test("classifies by the runtime's code, not by its wording", () => {
    const failure = openappaFailure(
      runtimeFailure("untrusted_log", "reworded by a later runtime"),
    );

    expectNoRetry(failure, 409);
  });
});

describe("openappaFailure: the model's requests", () => {
  test("a refused peer message shows the runtime's words to the model, without credentials", () => {
    const failure = openappaFailure(
      runtimeFailure(
        "peer_message",
        "OpenAPPA processing interrupted: a peer message of 70000 bytes exceeds the 65536 bytes a session takes in; see https://u:p@docs.internal/x",
      ),
    );

    expectNoRetry(failure, 400);
    expect(failure.message).toBe(
      "Guardrails refused this message: a peer message of 70000 bytes exceeds the 65536 bytes a session takes in; see https://docs.internal/x. Change the request and try again.",
    );
  });

  test.each([
    [
      "OpenAPPA remedy interrupted: [appa] the return declaration is refused: the reserved attest-schema sanitizer is not registered, or its rank is above this trajectory's; the offer stands and may be executed again",
      "Guardrails could not complete this remedy: the return declaration is refused: the reserved attest-schema sanitizer is not registered, or its rank is above this trajectory's; the offer stands and may be executed again.",
    ],
    [
      "OpenAPPA remedy interrupted: `return_schema` does not compile to a return shape: an array node must declare schema-valued `items` and a `maxItems` between 1 and 256",
      "Guardrails could not complete this remedy: `return_schema` does not compile to a return shape: an array node must declare schema-valued `items` and a `maxItems` between 1 and 256. Change the request and try again.",
    ],
    [
      "OpenAPPA processing interrupted: no live offer with this id exists",
      "Guardrails could not complete this remedy: no live offer with this id exists. Change the request and try again.",
    ],
  ])("a remedy refusal the runtime wrote for the model is shown once, without a retry: %s", (message, text) => {
    const failure = openappaFailure(runtimeFailure("remedy", message));

    expectNoRetry(failure, 400);
    expect(failure.message).toBe(text);
  });

  test("a long refusal is cut short once and an empty one still reads", () => {
    const long = openappaFailure(
      runtimeFailure(
        "annotation_refused",
        `OpenAPPA processing interrupted: annotator=appa/do_something error=${"x".repeat(300)}`,
      ),
    );
    expect(long.message).toMatch(/x… Change the request and try again\.$/);
    expect(long.message).not.toContain("….");

    const empty = openappaFailure(
      runtimeFailure("peer_message", "OpenAPPA processing interrupted: "),
    );
    expect(empty.message).toBe(
      "Guardrails refused this message. Change the request and try again.",
    );

    const asked = openappaFailure(
      runtimeFailure(
        "peer_message",
        "OpenAPPA processing interrupted: did you mean the held message?",
      ),
    );
    expect(asked.message).toBe(
      "Guardrails refused this message: did you mean the held message? Change the request and try again.",
    );
  });

  test.each([
    "OpenAPPA remedy interrupted: engine invariant breach: deciding an offer: this exact call already carries a current approval: propose it to release it",
    "OpenAPPA remedy interrupted: a remedy text this host does not know, for ada@example.com",
  ])("any other remedy refusal is a defect and keeps its detail out: %s", (message) => {
    const failure = openappaFailure(runtimeFailure("remedy", message));

    expectNoRetry(failure, 500);
    expect(failure.message).toMatch(
      /^Guardrails failed unexpectedly while checking this request\. Retrying will not help\. Give this reference to your administrator\. \(code: (?:engine_invariant|remedy)\)$/,
    );
  });
});

describe("openappaFailure: failures reported under another class", () => {
  test.each([
    [
      "remedy",
      "OpenAPPA remedy interrupted: storage failure: receipt storage failed: PostgreSQL ERROR (SQLSTATE 22P05)",
      400,
    ],
    [
      "remedy",
      "OpenAPPA remedy interrupted: storage failure: PostgreSQL FATAL (SQLSTATE 57P01)",
      503,
    ],
    [
      "remedy",
      "OpenAPPA remedy interrupted: the persisted log is refused: stored batch 3 does not decode",
      409,
    ],
    [
      "remedy",
      "OpenAPPA remedy interrupted: a call without a host id is already outstanding; this host must propose one unidentified call at a time",
      500,
    ],
    [
      "remedy",
      "OpenAPPA remedy interrupted: deployment default-org moved to policy revision 4 while this event was decided; retry it",
      503,
    ],
    [
      "trajectory",
      "the root fork could not be opened: storage failure: PostgreSQL ERROR (SQLSTATE 08006)",
      503,
    ],
    [
      "trajectory",
      "the root fork could not be opened: the policy is unavailable: the policy file 0a1b is not stored",
      409,
    ],
    ["trajectory", "the parent trajectory is not open in its family", 409],
  ])("%s carrying the runtime's own error is classified by that error: %s", (code, message, statusCode) => {
    expect(openappaFailure(runtimeFailure(code, message)).statusCode).toBe(
      statusCode,
    );
  });
});

describe("openappaFailure: wrapping", () => {
  test("does not wrap a failure twice", () => {
    const cause = runtimeFailure("policy_refused", "unsupported policy: x");
    const first = openappaFailure(cause);

    expect(first).toBeInstanceOf(ApiError);
    expect(openappaFailure(first)).toBe(first);
    expect(first.cause).toBe(cause);
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
    [
      "non_success status=1; this tool has no exact policy contract; run /appa-guide to write rules for this tool",
      "returned an error",
    ],
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
    // The model's own arguments, not an annotator that gave no answer.
    "OpenAPPA processing interrupted: annotator=appa/do_something error=timeout is not a `requires` key",
    // A remedy's refusal fails the request rather than one call.
    "OpenAPPA remedy interrupted: annotator=archestra.tool-call error=timeout",
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

function expectRetry(failure: ApiError): void {
  expect(failure.statusCode).toBe(503);
  expect(failure.shouldRetry).toBe(true);
  expect(failure.retryAfterSeconds).toBeGreaterThan(0);
}

function expectNoRetry(failure: ApiError, statusCode: number): void {
  expect(failure.statusCode).toBe(statusCode);
  expect(failure.shouldRetry).toBe(false);
  expect(failure.retryAfterSeconds).toBeUndefined();
}
